import { useEffect } from 'react'

const defaultFaviconHref = '/favicon.svg'
const attentionFaviconHref = '/favicon-notify.svg'

export function useFavicon(hasAttention: boolean) {
  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }

    const link = faviconLink()
    link.type = 'image/svg+xml'
    link.href = hasAttention ? attentionFaviconHref : defaultFaviconHref
  }, [hasAttention])
}

function faviconLink() {
  const existing = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
  if (existing) {
    return existing
  }

  const link = document.createElement('link')
  link.rel = 'icon'
  document.head.appendChild(link)
  return link
}
