self.addEventListener('install', (event) => {
  event.waitUntil(precacheAppShell().catch(() => undefined))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(cleanupCaches().then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') {
    return
  }

  const url = new URL(request.url)
  if (url.origin !== self.location.origin || isNetworkOnlyPath(url.pathname)) {
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(appShellResponse(event))
    return
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request))
    return
  }

  if (isStaticShellPath(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event))
  }
})

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
    ? Promise.resolve()
    : self.registration.showNotification(title, options).catch(() => undefined)

  event.waitUntil(Promise.all([attentionCount, badgeTask, showTask]))
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
    return Promise.resolve()
  }

  return attentionCount.then((count) => {
    const badgeCount = count > 0 ? count : 1
    return self.navigator.setAppBadge(badgeCount).catch(() => undefined)
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

const appShellCacheName = 'gorchestra-app-shell-v1'
const staticCacheName = 'gorchestra-static-v1'
const appShellCacheKey = '/__gorchestra_app_shell__'
const cacheNames = new Set([appShellCacheName, staticCacheName])
const staticShellPaths = new Set(['/favicon.svg', '/favicon-notify.svg', '/icon.svg', '/manifest.webmanifest'])

function isNetworkOnlyPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/service-worker.js'
}

function isStaticShellPath(pathname) {
  return staticShellPaths.has(pathname)
}

async function precacheAppShell() {
  const response = await fetch('/', { cache: 'no-cache', credentials: 'same-origin' })
  await cacheAppShellResponse(response)
}

async function appShellResponse(event) {
  const cache = await caches.open(appShellCacheName)
  const cached = await cache.match(appShellCacheKey)
  const refresh = fetchAndCacheAppShell(event.request)
  event.waitUntil(refresh.catch(() => undefined))

  if (cached) {
    return cached
  }

  return refresh
}

async function fetchAndCacheAppShell(request) {
  const response = await fetch(request)
  await cacheAppShellResponse(response)
  return response
}

async function cacheAppShellResponse(response) {
  if (!response || !response.ok || !isHTMLResponse(response)) {
    return
  }

  const html = await response.clone().text()
  if (!isProductionAppShellHTML(html)) {
    return
  }

  const cache = await caches.open(appShellCacheName)
  await cache.put(appShellCacheKey, response.clone())
}

function isHTMLResponse(response) {
  return (response.headers.get('Content-Type') || '').includes('text/html')
}

function isProductionAppShellHTML(html) {
  return html.includes('/assets/') && !html.includes('/src/main')
}

async function cacheFirst(request) {
  const cache = await caches.open(staticCacheName)
  const cached = await cache.match(request)
  if (cached) {
    return cached
  }

  const response = await fetch(request)
  if (isCacheableResponse(response)) {
    await cache.put(request, response.clone())
  }
  return response
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(staticCacheName)
  const cached = await cache.match(event.request)
  const refresh = fetchAndCacheStatic(event.request, cache)
  event.waitUntil(refresh.catch(() => undefined))
  return cached || refresh
}

async function fetchAndCacheStatic(request, cache) {
  const response = await fetch(request)
  if (isCacheableResponse(response)) {
    await cache.put(request, response.clone())
  }
  return response
}

function isCacheableResponse(response) {
  return response && response.ok && (response.type === 'basic' || response.type === 'default')
}

async function cleanupCaches() {
  const names = await caches.keys()
  await Promise.all(
    names.map((name) => {
      if (name.startsWith('gorchestra-') && !cacheNames.has(name)) {
        return caches.delete(name)
      }
      return undefined
    }),
  )
}
