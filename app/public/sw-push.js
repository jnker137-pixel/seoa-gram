const APP_URL = 'https://jnker137-pixel.github.io/seoa-gram/';

// 알람 클릭 후 새 창 열릴 때 iOS가 URL 파라미터를 무시하는 문제 우회
// ready 메시지로 앱이 준비되면 navigate 전달
let pendingNavigate = null;

self.addEventListener('message', (e) => {
  if (e.data?.type === 'ready' && pendingNavigate) {
    e.source.postMessage({ type: 'navigate', character: pendingNavigate });
    pendingNavigate = null;
  }
});

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
      data: { url: data.data?.url || APP_URL + '?character=seoa', character: data.data?.character || 'seoa' }
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const notifData = e.notification.data || {};
  const target = notifData.url || APP_URL + '?character=seoa';
  const character = notifData.character || 'seoa';

  pendingNavigate = character;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.startsWith(APP_URL) && 'focus' in client) {
          client.postMessage({ type: 'navigate', character });
          pendingNavigate = null;
          return client.focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});
