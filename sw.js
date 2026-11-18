// Service Worker – Ludwig Trainingstagebuch
// Push-Empfang für den persönlichen Test; die bestehende 22-Uhr-Logik bleibt separat.

const CACHE_NAME = 'ludwig-v1';
const APP_SCOPE = new URL(self.registration.scope);
const APP_HOME = new URL('index.html', APP_SCOPE).href;
const DEFAULT_ICON = new URL('icon-192.png', APP_SCOPE).href;
const LAST_REMINDER_KEY = new URL('__last_reminder__', APP_SCOPE).href;

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(clients.claim());
});

function appScopeUrl(value) {
  try {
    const url = new URL(value || 'index.html', APP_SCOPE);
    if (url.origin !== APP_SCOPE.origin || !url.pathname.startsWith(APP_SCOPE.pathname)) return APP_HOME;
    return url.href;
  } catch (_) {
    return APP_HOME;
  }
}

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = data.title || '🐴 Ludwig – Trainingstagebuch';
  const options = {
    body: data.body || 'Du hast eine neue Nachricht in Ludwig.',
    icon: appScopeUrl(data.icon || 'icon-192.png'),
    badge: appScopeUrl(data.badge || 'icon-192.png'),
    tag: data.tag || 'ludwig-notification',
    renotify: Boolean(data.renotify),
    requireInteraction: Boolean(data.requireInteraction),
    data: { url: appScopeUrl(data.url || 'index.html') }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = appScopeUrl(event.notification.data && event.notification.data.url);

  event.waitUntil((async () => {
    const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windowClients) {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin !== APP_SCOPE.origin || !clientUrl.pathname.startsWith(APP_SCOPE.pathname)) continue;
      if (client.url !== targetUrl && 'navigate' in client) await client.navigate(targetUrl);
      if ('focus' in client) return client.focus();
    }
    if (clients.openWindow) return clients.openWindow(targetUrl);
  })());
});

// Periodic Background Sync und Timer im Service Worker sind nicht auf allen Browsern dauerhaft verfügbar.
self.addEventListener('periodicsync', event => {
  if (event.tag === 'daily-reminder') event.waitUntil(checkAndNotify());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SCHEDULE_REMINDER') scheduleReminderAlarm();
  if (event.data && event.data.type === 'CHECK_AND_NOTIFY') {
    event.waitUntil(checkAndNotify());
  }
});

async function checkAndNotify() {
  const now = new Date();
  const todayStr = now.toDateString();
  const cache = await caches.open(CACHE_NAME);
  const lastReminderResp = await cache.match(LAST_REMINDER_KEY);
  const lastReminder = lastReminderResp ? await lastReminderResp.text() : null;
  if (lastReminder === todayStr) return;

  await self.registration.showNotification('🐴 Ludwig – Trainingstagebuch', {
    body: 'Du hast heute noch kein Training eingetragen! 🐴',
    icon: DEFAULT_ICON,
    tag: 'training-reminder',
    renotify: false,
    requireInteraction: false,
    data: { url: APP_HOME }
  });
  await cache.put(LAST_REMINDER_KEY, new Response(todayStr));
}

let alarmInterval = null;

function scheduleReminderAlarm() {
  if (alarmInterval) return;
  alarmInterval = setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 22 && now.getMinutes() === 0) await checkAndNotify();
  }, 60000);
}
