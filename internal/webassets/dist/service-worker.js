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
  const notificationData = notification.data || {}
  const title = notification.title || payload.title || 'Gorchestra'
  const targetURL = notification.navigate || notificationData.url || payload.url || '/'
  const sessionID = notificationData.session_id || payload.session_id || ''
  const eventType = notificationData.event_type || payload.event_type || ''
  const seq = Number(notificationData.seq || payload.seq || 0)
  const options = {
    body: notification.body || payload.body || 'A session stopped.',
    badge: '/favicon-notify.svg',
    icon: '/icon.svg',
    tag: notification.tag || payload.tag || 'gorchestra-session',
    data: {
      url: targetURL,
      session_id: sessionID,
      event_type: eventType,
      seq,
    },
  }

  const attentionCount = recordNotificationAttention(sessionID, seq)
  const declarative = shouldUseDeclarativeNotification(payload, notification)
  const badgeTask = setBadgeFromAttentionCount(attentionCount)
  const showTask = declarative
    ? Promise.resolve({ attempted: false, ok: false, reason: 'declarative' })
    : showNotification(title, options)

  event.waitUntil(
    Promise.all([attentionCount, badgeTask, showTask]).then(([count, badge, show]) =>
      recordNotificationDiagnostic({
        createdAt: Date.now(),
        userAgent: self.navigator?.userAgent || '',
        payloadWebPush: payload.web_push || null,
        declarative,
        badge,
        attentionCount: count,
        showNotification: show,
        sessionID,
        seq,
      }),
    ),
  )
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

function setBadgeFromAttentionCount(attentionCount) {
  if (!self.navigator || !('setAppBadge' in self.navigator)) {
    return Promise.resolve({ supported: false, attempted: false, ok: false, count: 0 })
  }

  return attentionCount.then((count) => {
    const badgeCount = count > 0 ? count : 1
    return self.navigator
      .setAppBadge(badgeCount)
      .then(() => ({ supported: true, attempted: true, ok: true, count: badgeCount }))
      .catch((error) => ({
        supported: true,
        attempted: true,
        ok: false,
        count: badgeCount,
        error: errorMessage(error),
      }))
  })
}

function shouldUseDeclarativeNotification(payload, notification) {
  if (payload.web_push !== 8030 || !notification || !notification.title || !notification.navigate) {
    return false
  }

  const userAgent = self.navigator?.userAgent || ''
  if (!userAgent) {
    return false
  }

  // WebKit ignores declarative fields like app_badge when the worker shows a
  // replacement notification. Let Safari handle the declarative notification.
  return /\bSafari\//.test(userAgent) && !/\b(?:Chrome|Chromium|CriOS|FxiOS|Edg|OPR)\//.test(userAgent)
}

function showNotification(title, options) {
  return self.registration
    .showNotification(title, options)
    .then(() => ({ attempted: true, ok: true }))
    .catch((error) => ({ attempted: true, ok: false, error: errorMessage(error) }))
}

function recordNotificationDiagnostic(diagnostic) {
  const tasks = [postNotificationDiagnostic(diagnostic)]
  if (!self.indexedDB) {
    return Promise.all(tasks).then(() => undefined)
  }

  tasks.push(new Promise((resolve) => {
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
      const transaction = db.transaction('sessions', 'readwrite')
      transaction.oncomplete = () => {
        db.close()
        resolve()
      }
      transaction.onerror = () => {
        db.close()
        resolve()
      }
      transaction.objectStore('sessions').put({
        sessionID: '__diagnostics__',
        seq: 0,
        createdAt: Date.now(),
        diagnostic,
      })
    }
  }))

  return Promise.all(tasks).then(() => undefined)
}

function postNotificationDiagnostic(diagnostic) {
  return fetch('/api/notifications/client-diagnostics', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(diagnostic),
  }).catch(() => undefined)
}

function errorMessage(error) {
  if (error && typeof error.message === 'string') {
    return error.message
  }
  return String(error)
}
