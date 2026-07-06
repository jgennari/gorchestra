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
  const sessionID = payload.session_id || ''
  const seq = Number(payload.seq || 0)
  const options = {
    body: notification.body || payload.body || 'A session stopped.',
    badge: '/favicon-notify.svg',
    icon: '/icon.svg',
    tag: notification.tag || payload.tag || 'gorchestra-session',
    data: {
      url: targetURL,
      session_id: sessionID,
      event_type: payload.event_type || '',
      seq,
    },
  }

  const attentionCount = recordNotificationAttention(sessionID, seq)
  const tasks = [self.registration.showNotification(title, options)]
  if (self.navigator && 'setAppBadge' in self.navigator) {
    tasks.push(attentionCount.then((count) => self.navigator.setAppBadge(count > 0 ? count : 1).catch(() => undefined)))
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

function recordNotificationAttention(sessionID, seq) {
  if (!sessionID || !Number.isFinite(seq) || seq <= 0 || !self.indexedDB) {
    return Promise.resolve(0)
  }

  return new Promise((resolve) => {
    const request = self.indexedDB.open('gorchestra-notification-attention', 1)
    request.onerror = () => resolve()
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'sessionID' })
      }
    }
    request.onsuccess = () => {
      const db = request.result
      let count = 1
      const transaction = db.transaction('sessions', 'readwrite')
      transaction.oncomplete = () => {
        db.close()
        resolve(count)
      }
      transaction.onerror = () => {
        db.close()
        resolve(0)
      }
      const store = transaction.objectStore('sessions')
      store.put({
        sessionID,
        seq,
        createdAt: Date.now(),
      })
      const countRequest = store.getAll()
      countRequest.onsuccess = () => {
        count = countRequest.result.filter((record) => record && record.sessionID && record.seq > 0).length
      }
    }
  })
}
