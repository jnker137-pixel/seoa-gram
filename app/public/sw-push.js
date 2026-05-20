const APP_URL = 'https://jnker137-pixel.github.io/seoa-gram/';

self.addEventListener('push', (e) => {
  const data = e.data?.json() || {};
  e.waitUntil(
    self.registration.showNotification(data.title || '서아', {
      body: data.body || '',
      icon: '/seoa-gram/favicon.svg',
      badge: '/seoa-gram/favicon.svg',
      vibrate: [200, 100, 200],
      data: { url: data.data?.url || APP_URL + '?character=seoa' }
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || APP_URL + '?character=seoa';
  e.waitUntil(clients.openWindow(target));
});
