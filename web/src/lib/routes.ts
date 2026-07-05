const sessionRoutePrefix = '/sessions/'

export type SessionRouteView = 'session' | 'console' | 'files'

export type SessionRoute = {
  sessionID: string | null
  view: SessionRouteView
}

const routeViews = new Set<SessionRouteView>(['console', 'files'])

export function sessionRouteFromPathname(pathname: string): SessionRoute {
  if (!pathname.startsWith(sessionRoutePrefix)) {
    return { sessionID: null, view: 'session' }
  }

  const [encodedID, viewSegment] = pathname.slice(sessionRoutePrefix.length).split('/')
  if (!encodedID) {
    return { sessionID: null, view: 'session' }
  }

  try {
    return {
      sessionID: decodeURIComponent(encodedID),
      view: routeViews.has(viewSegment as SessionRouteView) ? (viewSegment as SessionRouteView) : 'session',
    }
  } catch {
    return { sessionID: null, view: 'session' }
  }
}

export function sessionIDFromPathname(pathname: string) {
  return sessionRouteFromPathname(pathname).sessionID
}

export function sessionPath(sessionID: string | null, view: SessionRouteView = 'session') {
  if (!sessionID) {
    return '/'
  }

  const basePath = `/sessions/${encodeURIComponent(sessionID)}`
  return view === 'session' ? basePath : `${basePath}/${view}`
}
