// ───────────────────────────────────────────────────────────────────────────
//  amadeus-worker.js — Cloudflare Worker proxy for the Amadeus Self-Service API
//
//  WHY THIS EXISTS
//  The budget app is a static page on a PUBLIC GitHub repo. Amadeus requires an
//  API key *and secret*; putting the secret in the page would leak it to the
//  world, and Amadeus also doesn't allow direct browser calls (no CORS). This
//  Worker keeps the secret server-side, does the OAuth handshake, adds CORS
//  headers, and exposes three tiny read-only endpoints the app can call safely:
//
//    GET /iata?q=Paris
//    GET /flights?from=SAT&to=CDG&date=2026-08-01&return=2026-08-05&adults=2
//    GET /hotels?city=PAR&checkin=2026-08-01&checkout=2026-08-05&adults=2
//
//  SETUP (one time)
//  1. Create a free account at https://developers.amadeus.com and a Self-Service
//     app to get an API Key + API Secret.
//  2. Cloudflare dashboard → Workers & Pages → Create Worker → paste this file.
//  3. Worker → Settings → Variables and Secrets, add:
//        AMADEUS_KEY     = your API Key
//        AMADEUS_SECRET  = your API Secret      (mark as a Secret)
//        AMADEUS_ENV     = test                 (plain text; "test" or "production")
//     The free "test" environment returns limited/sample data. Switching to
//     "production" requires activating production in the Amadeus dashboard.
//  4. Copy the Worker URL and paste it into the app: Settings → Travel pricing.
// ───────────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Cached OAuth token for the life of a warm isolate (tokens last ~30 min).
let _tok = null; // { token, exp }

function json(status, obj) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return new Response(body, { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function getToken(env, base) {
  if (_tok && _tok.exp > Date.now() + 30000) return _tok.token;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.AMADEUS_KEY,
    client_secret: env.AMADEUS_SECRET,
  });
  const r = await fetch(base + '/v1/security/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error('Amadeus auth failed (HTTP ' + r.status + ') — check AMADEUS_KEY/SECRET');
  const j = await r.json();
  _tok = { token: j.access_token, exp: Date.now() + (j.expires_in || 1700) * 1000 };
  return _tok.token;
}

// GET an Amadeus path with a bearer token; returns parsed JSON (or throws).
async function amadeus(env, base, path) {
  const tok = await getToken(env, base);
  const r = await fetch(base + path, { headers: { Authorization: 'Bearer ' + tok } });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = null; }
  if (r.status >= 400) {
    const msg = (j && j.errors && j.errors[0] && (j.errors[0].detail || j.errors[0].title)) || ('HTTP ' + r.status);
    throw new Error(msg);
  }
  return j || {};
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '');
    const q = url.searchParams;
    const base = (env.AMADEUS_ENV === 'production')
      ? 'https://api.amadeus.com'
      : 'https://test.api.amadeus.com';
    try {
      if (!env.AMADEUS_KEY || !env.AMADEUS_SECRET) {
        return json(500, { error: 'Worker is missing AMADEUS_KEY / AMADEUS_SECRET variables.' });
      }

      // 1) Resolve a place name → IATA city/airport codes.
      if (p.endsWith('/iata')) {
        const kw = q.get('q') || '';
        if (!kw) return json(400, { error: 'Missing q' });
        const data = await amadeus(env, base,
          '/v1/reference-data/locations?subType=CITY,AIRPORT&page%5Blimit%5D=6&keyword=' + encodeURIComponent(kw));
        return json(200, data);
      }

      // 2) Cheapest round-trip (or one-way) flight offers.
      if (p.endsWith('/flights')) {
        const from = q.get('from'), to = q.get('to'), date = q.get('date');
        const adults = q.get('adults') || '2', ret = q.get('return');
        if (!from || !to || !date) return json(400, { error: 'Need from, to, date' });
        let path = `/v2/shopping/flight-offers?originLocationCode=${from}&destinationLocationCode=${to}`
          + `&departureDate=${date}` + (ret ? `&returnDate=${ret}` : '')
          + `&adults=${adults}&currencyCode=USD&max=8`;
        const data = await amadeus(env, base, path);
        return json(200, data);
      }

      // 3) Hotel offers: resolve hotels in the city, then price them.
      if (p.endsWith('/hotels')) {
        const city = q.get('city'), ci = q.get('checkin'), co = q.get('checkout');
        const adults = q.get('adults') || '2';
        if (!city || !ci || !co) return json(400, { error: 'Need city, checkin, checkout' });
        const list = await amadeus(env, base,
          `/v1/reference-data/locations/hotels/by-city?cityCode=${city}`);
        const ids = (list.data || []).slice(0, 25).map(h => h.hotelId).filter(Boolean).join(',');
        if (!ids) return json(200, { data: [] });
        const data = await amadeus(env, base,
          `/v3/shopping/hotel-offers?hotelIds=${ids}&adults=${adults}`
          + `&checkInDate=${ci}&checkOutDate=${co}&roomQuantity=1&bestRateOnly=true&currency=USD`);
        return json(200, data);
      }

      return json(404, { error: 'Unknown path. Use /iata, /flights, or /hotels.' });
    } catch (e) {
      return json(502, { error: String((e && e.message) || e) });
    }
  },
};
