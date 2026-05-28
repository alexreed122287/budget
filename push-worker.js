// Cloudflare Worker — Web Push (VAPID-signed) delivery relay.
//
// Why a separate worker? VAPID signing requires ECDSA P-256, which
// the Google Apps Script runtime can't do. Cloudflare Workers run a
// real crypto.subtle that can, and the free tier (100k requests/day)
// is more than enough for personal use.
//
// Deploy: copy this file into a Cloudflare Worker (Dashboard or
// `wrangler deploy`). Set environment secret VAPID_PRIVATE (base64url
// PKCS#8 P-256 private key produced by make-vapid.sh). Set
// VAPID_PUBLIC env var (base64url uncompressed P-256 public key).
// Set VAPID_SUBJECT env var to "mailto:you@example.com".
//
// The Apps Script cron POSTs to this worker:
//   POST <worker-url>/send
//   Content-Type: application/json
//   { "subscription": <PushSubscription JSON>, "payload": <object> }

export default {
  async fetch(req, env) {
    if (req.method !== 'POST') return new Response('OK push-worker — POST /send to deliver', { status: 200 });
    const url = new URL(req.url);
    if (url.pathname !== '/send') return new Response('Not found', { status: 404 });
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
    const sub = body.subscription;
    const payload = body.payload || {};
    if (!sub || !sub.endpoint || !sub.keys) return json({ ok: false, error: 'missing subscription' }, 400);
    try {
      const ok = await sendWebPush(sub, payload, {
        publicKey: env.VAPID_PUBLIC,
        privateKey: env.VAPID_PRIVATE,
        subject: env.VAPID_SUBJECT || 'mailto:owner@example.com',
      });
      return json({ ok: true, status: ok });
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500);
    }
  },
};

function json(o, st) { return new Response(JSON.stringify(o), { status: st || 200, headers: { 'content-type': 'application/json' } }); }

// ── base64url helpers ──────────────────────────────────────────────
const b64uEncode = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
};
const b64uDecode = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4; if (pad) s += '='.repeat(4 - pad);
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};
const concat = (...arrs) => {
  const total = arrs.reduce((s, a) => s + a.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(new Uint8Array(a), off); off += a.byteLength; }
  return out;
};
const utf8 = (s) => new TextEncoder().encode(s);

// ── VAPID JWT signing (ES256) ──────────────────────────────────────
async function importVapidPrivate(b64uPkcs8) {
  return crypto.subtle.importKey(
    'pkcs8', b64uDecode(b64uPkcs8).buffer,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
}
async function vapidJwt(audience, subject, privateKeyB64u) {
  const header = b64uEncode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claim  = b64uEncode(utf8(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const signingInput = header + '.' + claim;
  const key = await importVapidPrivate(privateKeyB64u);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } }, key, utf8(signingInput),
  );
  return signingInput + '.' + b64uEncode(sig);
}

// ── aes128gcm payload encryption (RFC 8291) ────────────────────────
// Encrypts `body` for the recipient using their p256dh + auth secret.
async function encryptPayload(body, clientPublicB64u, authSecretB64u) {
  const plaintext = utf8(typeof body === 'string' ? body : JSON.stringify(body));
  const clientPub = b64uDecode(clientPublicB64u);    // uncompressed P-256 (65 bytes)
  const auth      = b64uDecode(authSecretB64u);      // 16-byte auth secret
  const salt      = crypto.getRandomValues(new Uint8Array(16));

  // 1) ephemeral server EC key pair
  const ecdh = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ecdh.publicKey));

  // 2) shared secret
  const clientPubKey = await crypto.subtle.importKey(
    'raw', clientPub.buffer, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const ikm = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPubKey }, ecdh.privateKey, 256));

  // 3) HKDF — PRK_key from (auth, ikm)
  async function hkdfExtract(salt, ikm) {
    const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm));
  }
  async function hkdfExpand(prk, info, len) {
    const key = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    let t = new Uint8Array(0);
    let okm = new Uint8Array(0);
    let counter = 1;
    while (okm.length < len) {
      const input = concat(t, info, new Uint8Array([counter]));
      t = new Uint8Array(await crypto.subtle.sign('HMAC', key, input));
      okm = concat(okm, t);
      counter++;
    }
    return okm.slice(0, len);
  }

  // key_info  = "WebPush: info\x00" || ua_public || as_public
  const prkKey = await hkdfExtract(auth, ikm);
  const keyInfo = concat(utf8('WebPush: info\0'), clientPub, serverPubRaw);
  const ikmFinal = await hkdfExpand(prkKey, concat(keyInfo, new Uint8Array([1])), 32);

  // PRK from (salt, ikmFinal)
  const prk = await hkdfExtract(salt, ikmFinal);
  const cek = await hkdfExpand(prk, concat(utf8('Content-Encoding: aes128gcm\0'), new Uint8Array([1])), 16);
  const nonce = await hkdfExpand(prk, concat(utf8('Content-Encoding: nonce\0'), new Uint8Array([1])), 12);

  // Encrypt: payload || 0x02 (last record)
  const plain = concat(plaintext, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plain));

  // Build aes128gcm record:
  //   salt (16) | rs (4, BE) | idlen (1) | keyid (idlen) | ciphertext
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + serverPubRaw.length);
  header.set(salt, 0);
  // record size
  header[16] = (rs >> 24) & 0xff; header[17] = (rs >> 16) & 0xff;
  header[18] = (rs >> 8) & 0xff;  header[19] = rs & 0xff;
  header[20] = serverPubRaw.length;
  header.set(serverPubRaw, 21);
  return concat(header, cipher);
}

// ── Web Push send ──────────────────────────────────────────────────
async function sendWebPush(subscription, payload, vapid) {
  const epUrl = new URL(subscription.endpoint);
  const audience = epUrl.origin;
  const jwt = await vapidJwt(audience, vapid.subject, vapid.privateKey);

  const body = await encryptPayload(payload, subscription.keys.p256dh, subscription.keys.auth);

  const headers = {
    'TTL': '60',
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    'Authorization': `vapid t=${jwt}, k=${vapid.publicKey}`,
    'Urgency': 'normal',
  };

  const res = await fetch(subscription.endpoint, { method: 'POST', headers, body });
  // 201 (Created) or 202 (Accepted) = success; 410/404 = gone (unsubscribe).
  return res.status;
}
