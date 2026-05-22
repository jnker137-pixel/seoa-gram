const APP_URL = 'https://jnker137-pixel.github.io/seoa-gram/';

self.addEventListener('push', (e) => {
  const data = e.data?.json() || {};
  const character = data.data?.character;
  const icon = character
    ? APP_URL + 'avatars/' + character + '.png'
    : APP_URL + 'favicon.svg';

  e.waitUntil(
    self.registration.showNotification(data.title || '서아', {
      body: data.body || '',
      icon: icon,
      badge: APP_URL + 'favicon.svg',
      vibrate: [200, 100, 200],
      requireInteraction: true,
      data: { url: data.data?.url || APP_URL + '?character=seoa' }
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const notifData = e.notification.data || {};
  const target = notifData.url || APP_URL + '?character=seoa';
  const character = notifData.character || 'seoa';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.startsWith(APP_URL) && 'focus' in client) {
          client.postMessage({ type: 'navigate', character });
          return client.focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});
