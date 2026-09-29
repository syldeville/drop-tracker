self.addEventListener('push', e => {
  const { title, body } = e.data.json();
  e.waitUntil(self.registration.showNotification(title, { body, icon: 'icon.png' }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('./'));
});
