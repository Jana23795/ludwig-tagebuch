// Service Worker – Ludwig Trainingstagebuch
// Push-Empfang für den persönlichen Test; die bestehende 22-Uhr-Logik bleibt separat.

const CACHE_NAME = 'ludwig-v1';

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(clients.claim());
});

function sameOriginUrl(value) {
  try {
    const url = new URL(value || '/index.html', self.location.origin);
    return url.origin === self.location.origin ? url.href : new URL('/index.html', self.location.origin).href;
  } catch (_) {
    return new URL('/index.html', self.location.origin).href;
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
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    tag: data.tag || 'ludwig-notification',
    renotify: Boolean(data.renotify),
    requireInteraction: Boolean(data.requireInteraction),
    data: { url: sameOriginUrl(data.url || '/index.html') }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = sameOriginUrl(event.notification.data && event.notification.data.url);

  event.waitUntil((async () => {
    const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windowClients) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      if (client.url !== targetUrl && 'navigate' in client) await client.navigate(targetUrl);
      if ('focus' in client) return client.focus();
    }
    if (clients.openWindow) return clients.openWindow(targetUrl);
  })());
});

// Bestehende 22-Uhr-Logik bleibt erhalten. Periodic Background Sync und ein
// Timer im Service Worker sind nicht auf allen Browsern verfügbar oder dauerhaft.
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
  const lastReminderResp = await cache.match('/__last_reminder__');
  const lastReminder = lastReminderResp ? await lastReminderResp.text() : null;
  if (lastReminder === todayStr) return;

  await self.registration.showNotification('🐴 Ludwig – Trainingstagebuch', {
    body: 'Du hast heute noch kein Training eingetragen! 🐴',
    icon: '/icon-192.png',
    tag: 'training-reminder',
    renotify: false,
    requireInteraction: false,
    data: { url: sameOriginUrl('/index.html') }
  });
  await cache.put('/__last_reminder__', new Response(todayStr));
}

let alarmInterval = null;

function scheduleReminderAlarm() {
  if (alarmInterval) return;
  alarmInterval = setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 22 && now.getMinutes() === 0) await checkAndNotify();
  }, 60000);
}
