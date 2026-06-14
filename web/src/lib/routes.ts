const sessionRoutePrefix = '/sessions/'

export function sessionIDFromPathname(pathname: string) {
  if (!pathname.startsWith(sessionRoutePrefix)) {
    return null
  }

  const encodedID = pathname.slice(sessionRoutePrefix.length).split('/')[0]
  if (!encodedID) {
    return null
  }

  try {
    return decodeURIComponent(encodedID)
  } catch {
    return null
  }
}

export function sessionPath(sessionID: string | null) {
  return sessionID ? `/sessions/${encodeURIComponent(sessionID)}` : '/'
}
