# Live flight & hotel prices (Amadeus)

The Vacation tab can show **real flight and hotel prices** instead of AI ballparks.
It uses the free **Amadeus Self-Service API**. Because Amadeus needs a secret key —
which can't be exposed on a public web page — prices route through a tiny Cloudflare
Worker you deploy once. Setup takes ~10 minutes.

## 1. Get Amadeus API keys (free)

1. Sign up at <https://developers.amadeus.com> and confirm your email.
2. Go to **My Self-Service Workspace → Create new app**.
3. Copy the **API Key** and **API Secret**.

The free **test** environment returns limited/sample data (a subset of routes and
hotels). To get full coverage you later switch the app to **production** in the Amadeus
dashboard (still free up to a monthly quota).

## 2. Deploy the proxy Worker

1. In the Cloudflare dashboard: **Workers & Pages → Create → Create Worker**.
2. Name it (e.g. `amadeus-worker`), click **Deploy**, then **Edit code**.
3. Replace the contents with [`amadeus-worker.js`](amadeus-worker.js) from this repo and **Deploy**.
4. Open the Worker's **Settings → Variables and Secrets** and add:

   | Name             | Value                | Type        |
   |------------------|----------------------|-------------|
   | `AMADEUS_KEY`    | your API Key         | Secret      |
   | `AMADEUS_SECRET` | your API Secret      | Secret      |
   | `AMADEUS_ENV`    | `test`               | Plain text  |

   When you're ready for full data, activate production in Amadeus and change
   `AMADEUS_ENV` to `production`.

5. Copy the Worker URL (e.g. `https://amadeus-worker.YOURNAME.workers.dev`).

## 3. Connect the app

In the budget app: **Settings → Travel pricing → Amadeus proxy Worker URL**, paste the
Worker URL. That's it — the value syncs to every device that has the app key.

## 4. Use it

On the **Vacation** tab, open any **idea**, set the departure date / nights / travelers,
and tap **✦ Flights & hotels**. You'll get the cheapest round-trip fare from San Antonio
(SAT) and a range of hotel nightly totals for the destination.

## Endpoints the Worker exposes

All read-only `GET`, all CORS-enabled:

- `/iata?q=Paris` — resolve a place name to IATA city/airport codes
- `/flights?from=SAT&to=CDG&date=2026-08-01&return=2026-08-05&adults=2`
- `/hotels?city=PAR&checkin=2026-08-01&checkout=2026-08-05&adults=2`

## Notes & limits

- **Test data is sparse.** If flights/hotels come back empty, the route or city likely
  isn't in the test dataset — switch `AMADEUS_ENV` to `production` for real coverage.
- The Worker caches the OAuth token in memory between calls (tokens last ~30 min).
- Your Amadeus secret lives only in the Worker's environment, never in the app or repo.
- Prices are quotes at fetch time; always confirm on the airline/hotel site before booking.
