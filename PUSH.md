# Closed-app push notifications (To-Do & Calendar reminders)

The in-app reminder loop only fires while the tab is open. To get OS-level
notifications **when the app is closed** (lock-screen alerts on iPhone, system
banners on macOS / Android), wire up the four pieces below. One-time setup —
~15 minutes — after that, every device that taps **Settings → Push →
Enable push on this device** gets reminders pushed to it.

```
   ┌────────────┐        ┌─────────────────┐        ┌──────────────────┐
   │ Apps Script│ 1/min  │ Cloudflare      │ VAPID  │ Push service     │
   │ trigger    ├───────▶│ Worker (signs   ├───────▶│ (Apple / FCM /   │
   │ sendDuePushes()     │  & encrypts)    │        │  Mozilla)        │
   └─────┬──────┘        └─────────────────┘        └────────┬─────────┘
         │ reads to-dos / events                              │
         │ from the same Sheet                                ▼
         │                                          ┌──────────────────┐
         │                                          │ Service worker   │
         │ stores subscriptions in the Sheet  ◀─────│ on the device    │
         │                                          │ (sw.js)          │
         ▼                                          └──────────────────┘
   Browser tab subscribes via Settings → Push
```

---

## 1.  Generate a VAPID key pair  (your push identity — 30 seconds)

VAPID is just an ECDSA P-256 key. The push services need it to prove the
push came from you. Keep the **private** key secret — it never goes into the
client, the repo, or the Sheet.

```sh
cd ~/budget-work
./make-vapid.sh
```

You'll get two base64url strings — `PUBLIC` and `PRIVATE`. Copy both
somewhere safe (e.g. your password manager) before closing the terminal.

---

## 2.  Deploy the Cloudflare Worker  (5 minutes, free tier — 100k req/day)

The Worker does the cryptographic work the Apps Script runtime can't:
ES256 JWT signing + aes128gcm payload encryption (RFC 8291).

1. Sign in at https://dash.cloudflare.com → **Workers & Pages** → **Create**.
2. Pick **Create Worker**, name it anything (e.g. `budget-push`), click
   **Deploy** with the default Hello World, then **Edit code**.
3. Replace the whole file with the contents of
   [`push-worker.js`](push-worker.js). Click **Save and deploy**.
4. In the Worker dashboard → **Settings → Variables** add:

   | Name             | Type        | Value                                                    |
   |------------------|-------------|----------------------------------------------------------|
   | `VAPID_PUBLIC`   | Plaintext   | the **PUBLIC** string from step 1                        |
   | `VAPID_SUBJECT`  | Plaintext   | `mailto:alexander.s.reed@gmail.com` (or any contact URL) |
   | `VAPID_PRIVATE`  | **Secret**  | the **PRIVATE** string from step 1                       |

5. Copy the Worker URL (it ends in `.workers.dev`). You'll paste it in step 4.

> Sanity check: `curl https://your-worker.workers.dev/` should return
> `OK push-worker — POST /send to deliver`.

---

## 3.  Install the Apps Script cron  (2 minutes)

The Apps Script that backs the Sheet already has the cron entry-point —
`sendDuePushes()` in `apps-script.gs`. You just need to trigger it.

1. Open your **budget Google Sheet** → **Extensions → Apps Script**.
2. Make sure the script there matches [`apps-script.gs`](apps-script.gs) in
   this repo (paste over if you haven't updated it since the push work).
   Click **Save**, then **Deploy → Manage deployments → Edit** (pencil) →
   **New version** → **Deploy** so the new `subscribePush`/`unsubscribePush`
   actions go live on the same webhook URL.
3. In the Apps Script editor, open the **Triggers** panel (clock icon, left
   sidebar) → **+ Add Trigger**:
   - Function: `sendDuePushes`
   - Deployment: **Head**
   - Event source: **Time-driven**
   - Type: **Minutes timer**
   - Interval: **Every minute**
   - Click **Save**, accept the auth prompt.
4. The trigger runs every minute, walks today's to-dos + calendar events,
   computes each reminder's fire time, and POSTs anything due in the last 90
   seconds to your Worker. Fired reminders are remembered (last 500 keys) so
   you don't get the same alert twice.

> The Worker URL the cron POSTs to comes from the Sheet itself — it's the
> value you'll paste in step 4. No secrets live in the Apps Script.

---

## 4.  Enable push in the app  (per device — 15 seconds each)

1. Open the app on the device.
   **iPhone**: you MUST first add the app to your Home Screen (Share →
   Add to Home Screen) and open it from the Home Screen icon — Safari's
   regular tab can't receive Web Push. Same for iPad.
2. **Settings → Push notifications**:
   - **Push worker URL**: `https://your-worker.workers.dev`
   - **VAPID public key**: the **PUBLIC** string from step 1
3. Tap **Enable push on this device**. Allow the permission prompt.
   The status line shows `✓ Enabled — N device(s) registered`.
4. Tap **Send test** — you should get a notification within a couple of
   seconds saying *"It works — closed-app reminders are wired up."*
5. Repeat on every device you want reminders on (spouse's phone, laptop,
   etc.). Each device upserts itself into the same Sheet by its endpoint.

---

## 5.  How reminders fire

Same rules as the in-app loop, but driven by the Apps Script cron so they
fire whether or not the app is open:

**To-Do** (`Settings → Push` enabled + to-do has a `Remind` setting):

| Remind preset       | Fires at …                                       |
|---------------------|--------------------------------------------------|
| Night before · 7 pm | the day before the due date, 19:00 local         |
| Morning of · 8 am   | the morning of the due date, 08:00 local         |
| At due time         | the dueTime on the due date (or 9 am if blank)   |
| 1 hour before       | dueTime − 1 h                                    |
| 30 min before       | dueTime − 30 min                                 |
| 2 days before · 7 pm| due date − 2 days, 19:00                         |
| 1 week before · 7 pm| due date − 7 days, 19:00                         |

**Calendar event** (event has `Remind` set in the calendar editor):

Recurring events recur (`daily`/`weekly`/`biweekly`/`monthly`/`yearly`)
based on the original start date; the reminder fires `remindMins` minutes
before the event time, every occurrence.

The cron tolerates 90-second drift (so a 12:00 reminder fires any time the
cron runs between 12:00 and 12:01:30), and never re-fires the same key.

---

## 6.  Privacy / cost

- Push payload contains only the to-do/event title + short body + a URL —
  no balances, no account info. Encrypted end-to-end (RFC 8291).
- The Worker has no log retention beyond Cloudflare's default request
  metrics; nothing is persisted server-side beyond the in-flight request.
- Subscriptions live in the same Sheet your budget data lives in. Removing
  the subscription is a tap (**Disable on this device**) or a row delete
  from `_data`'s JSON.
- Free tier:
  - Cloudflare Worker: 100,000 requests/day
  - Apps Script triggers: 90 min/day total runtime (each fire is < 1 s)

  Two devices × ~10 reminders/day = ~20 push requests/day. You're nowhere
  near any limit.

---

## 7.  Troubleshooting

| Symptom                                   | Fix                                                                                          |
|-------------------------------------------|----------------------------------------------------------------------------------------------|
| "Push not supported" on iPhone Safari     | You opened the regular Safari tab — open from the Home Screen icon instead.                  |
| Enable says ✓ but **Send test** times out | Check the Worker URL is exact (`https://…workers.dev`, no trailing slash).                   |
| Worker returns `missing subscription`     | Re-enable on the device; the JSON didn't include `keys.p256dh` / `keys.auth`.                |
| Worker returns 401 / VAPID error          | The `VAPID_PUBLIC` in the Worker doesn't match what's in Settings → Push. Make them equal.   |
| No closed-app pushes ever fire            | Check the Apps Script trigger is installed (Triggers panel) and `sendDuePushes` is the head. |
| Test push works but reminders don't       | Make sure each to-do has a `Remind` setting (not `none`) and that you tapped the row to set it.|

If a push service returns 410 (subscription gone — user uninstalled / wiped
the browser), the cron auto-removes the subscription from the Sheet.
