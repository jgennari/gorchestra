export function registerAppServiceWorker() {
  if (
    typeof window === 'undefined' ||
    !window.isSecureContext ||
    !('serviceWorker' in navigator)
  ) {
    return
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch(() => undefined)
  })
}
