// ============================================================
// Service Worker – Ludwig Trainingstagebuch
// Täglich 22:00 Uhr Erinnerung
// ============================================================

const CACHE_NAME = 'ludwig-v1';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(clients.claim());
});

// Push-Event: kommt vom Server (oder simuliert via showNotification)
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || '🐴 Ludwig – Trainingstagebuch';
  const options = {
    body: data.body || 'Du hast heute noch kein Training eingetragen! 🐴',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    tag: 'training-reminder',
    renotify: false,
    requireInteraction: false,
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Notification-Klick: App öffnen
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});

// ── Tägliche 22-Uhr-Erinnerung via periodSync (wo verfügbar)
// oder via selbst-geplantem Alarm im SW
self.addEventListener('periodicsync', event => {
  if (event.tag === 'daily-reminder') {
    event.waitUntil(checkAndNotify());
  }
});

// Fallback: Message vom App-Fenster
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SCHEDULE_REMINDER') {
    scheduleReminderAlarm();
  }
  if (event.data && event.data.type === 'CHECK_AND_NOTIFY') {
    checkAndNotify();
  }
});

async function checkAndNotify() {
  const now = new Date();
  const todayStr = now.toDateString();

  // Prüfen ob heute schon erinnert wurde (via Cache-Storage als Persistenz)
  const cache = await caches.open(CACHE_NAME);
  const lastReminderResp = await cache.match('/__last_reminder__');
  const lastReminder = lastReminderResp ? await lastReminderResp.text() : null;

  if (lastReminder === todayStr) return; // heute schon erinnert

  await self.registration.showNotification('🐴 Ludwig – Trainingstagebuch', {
    body: 'Du hast heute noch kein Training eingetragen! 🐴',
    tag: 'training-reminder',
    renotify: false,
    requireInteraction: false
  });

  // Merken dass heute erinnert wurde
  await cache.put('/__last_reminder__', new Response(todayStr));
}

// Alarm-Planung: prüft jede Minute ob es 22:00 ist
// (läuft nur wenn SW aktiv ist – also wenn App offen ist oder im Hintergrund gehalten wird)
let alarmInterval = null;

function scheduleReminderAlarm() {
  if (alarmInterval) return;
  alarmInterval = setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 22 && now.getMinutes() === 0) {
      await checkAndNotify();
    }
  }, 60000);
}
