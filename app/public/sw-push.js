const APP_URL = 'https://jnker137-pixel.github.io/seoa-gram/';

const CHAR_ICONS = {
  'seoa':       APP_URL + 'avatars/seoa.jpeg',
  'seoa-swing': APP_URL + 'avatars/seoa-swing.svg',
  'harin':      APP_URL + 'avatars/harin.jpeg',
  'ria':        APP_URL + 'avatars/ria.svg',
  'luna':       APP_URL + 'avatars/luna.svg',
};

self.addEventListener('push', (e) => {
  const data = e.data?.json() || {};
  const character = data.data?.character;
  const icon = CHAR_ICONS[character] || APP_URL + 'favicon.svg';

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
  const target = (e.notification.data && e.notification.data.url) || APP_URL + '?character=seoa';
  e.waitUntil(clients.openWindow(target));
});
