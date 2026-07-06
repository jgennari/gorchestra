self.addEventListener('push', (event) => {
  let payload = {}
  if (event.data) {
    try {
      payload = event.data.json()
    } catch {
      payload = { body: event.data.text() }
    }
  }

  const notification = payload.notification || {}
  const title = notification.title || payload.title || 'Gorchestra'
  const targetURL = notification.navigate || payload.url || '/'
  const options = {
    body: notification.body || payload.body || 'A session stopped.',
    badge: '/favicon-notify.svg',
    icon: '/icon.svg',
    tag: notification.tag || payload.tag || 'gorchestra-session',
    data: {
      url: targetURL,
      session_id: payload.session_id || '',
      event_type: payload.event_type || '',
    },
  }

  const tasks = [self.registration.showNotification(title, options)]
  if (self.navigator && 'setAppBadge' in self.navigator) {
    tasks.push(self.navigator.setAppBadge(1).catch(() => undefined))
  }

  event.waitUntil(Promise.all(tasks))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetURL = new URL(event.notification.data?.url || '/', self.location.origin).href

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url === targetURL && 'focus' in client) {
          return client.focus()
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetURL)
      }
      return undefined
    }),
  )
})
