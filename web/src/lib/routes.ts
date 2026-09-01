const sessionRoutePrefix = '/sessions/'

export type SessionRouteView = 'session' | 'console' | 'schedules' | 'skills' | 'files' | 'host'

export type SessionRoute = {
  sessionID: string | null
  sessionSlug: string | null
  view: SessionRouteView
  filePath: string | null
}

const routeViews = new Set<SessionRouteView>(['console', 'schedules', 'skills', 'files', 'host'])

export function sessionRouteFromPathname(pathname: string): SessionRoute {
  if (!pathname.startsWith(sessionRoutePrefix)) {
    return emptySessionRoute()
  }

  const [encodedSessionRouteKey, viewSegment, ...filePathSegments] = pathname.slice(sessionRoutePrefix.length).split('/')
  if (!encodedSessionRouteKey) {
    return emptySessionRoute()
  }

  try {
    const sessionRouteKey = decodeURIComponent(encodedSessionRouteKey)
    const view = routeViews.has(viewSegment as SessionRouteView) ? (viewSegment as SessionRouteView) : 'session'
    const filePath = view === 'files' && filePathSegments.length > 0 ? decodeURIComponent(filePathSegments.join('/')) : null
    if (sessionRouteKey.startsWith('sess_')) {
      return { sessionID: sessionRouteKey, sessionSlug: null, view, filePath }
    }
    return {
      sessionID: null,
      sessionSlug: sessionRouteKey,
      view,
      filePath,
    }
  } catch {
    return emptySessionRoute()
  }
}

export function sessionIDFromPathname(pathname: string) {
  return sessionRouteFromPathname(pathname).sessionID
}

export function sessionPath(sessionID: string | null, view: SessionRouteView = 'session', filePath: string | null = null) {
  if (!sessionID) {
    return '/'
  }

  const basePath = `/sessions/${encodeURIComponent(sessionID)}`
  return sessionViewPath(basePath, view, filePath)
}

export function sessionSlugPath(sessionSlug: string | null, view: SessionRouteView = 'session', filePath: string | null = null) {
  if (!sessionSlug) {
    return '/'
  }

  const basePath = `/sessions/${encodeURIComponent(sessionSlug)}`
  return sessionViewPath(basePath, view, filePath)
}

export function sessionTitleSlug(title: string) {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'untitled-session'
}

function emptySessionRoute(): SessionRoute {
  return { sessionID: null, sessionSlug: null, view: 'session', filePath: null }
}

function sessionViewPath(basePath: string, view: SessionRouteView, filePath: string | null) {
  if (view === 'session') {
    return basePath
  }
  if (view === 'files' && filePath) {
    return `${basePath}/files/${encodeURIComponent(filePath)}`
  }
  return `${basePath}/${view}`
}
