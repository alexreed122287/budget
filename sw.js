// Service worker for closed-app push notifications.
// The page registers this once. The push backend (Cloudflare Worker
// triggered by the Apps Script cron) signs a VAPID push and delivers
// it via the user's browser's push service (FCM / APNs / Mozilla).
// When delivered, this worker fires the OS-level notification —
// regardless of whether the app tab is open.

const APP_NAME = 'Budget';

self.addEventListener('install',  e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data ? event.data.text() : '' }; }
  const title = payload.title || APP_NAME;
  const body  = payload.body  || '';
  const url   = payload.url   || '/';
  const tag   = payload.tag   || ('reed-' + Date.now());
  const opts = {
    body, tag, renotify: !!payload.renotify,
    icon: 'icon-192.png', badge: 'icon-192.png',
    data: { url },
    requireInteraction: !!payload.requireInteraction,
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    // If a tab is already open, focus it; else open one.
    for (const c of all) {
      if ('focus' in c) { try { return c.focus(); } catch {} }
    }
    if (clients.openWindow) return clients.openWindow(url);
  })());
});
