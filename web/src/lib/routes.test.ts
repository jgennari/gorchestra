import { sessionIDFromPathname, sessionPath, sessionRouteFromPathname } from '@/lib/routes'

test('session route helpers parse and build session paths', () => {
  expect(sessionIDFromPathname('/sessions/sess_123')).toBe('sess_123')
  expect(sessionIDFromPathname('/sessions/sess_%2Fencoded/events')).toBe('sess_/encoded')
  expect(sessionIDFromPathname('/')).toBeNull()
  expect(sessionIDFromPathname('/sessions/')).toBeNull()
  expect(sessionIDFromPathname('/sessions/%E0%A4%A')).toBeNull()

  expect(sessionRouteFromPathname('/sessions/sess_123')).toEqual({ sessionID: 'sess_123', view: 'session' })
  expect(sessionRouteFromPathname('/sessions/sess_123/console')).toEqual({
    sessionID: 'sess_123',
    view: 'console',
  })
  expect(sessionRouteFromPathname('/sessions/sess_123/files')).toEqual({ sessionID: 'sess_123', view: 'files' })
  expect(sessionRouteFromPathname('/sessions/sess_123/events')).toEqual({
    sessionID: 'sess_123',
    view: 'session',
  })
  expect(sessionRouteFromPathname('/')).toEqual({ sessionID: null, view: 'session' })

  expect(sessionPath('sess_123')).toBe('/sessions/sess_123')
  expect(sessionPath('sess_123', 'console')).toBe('/sessions/sess_123/console')
  expect(sessionPath('sess_123', 'files')).toBe('/sessions/sess_123/files')
  expect(sessionPath('sess_/encoded')).toBe('/sessions/sess_%2Fencoded')
  expect(sessionPath(null)).toBe('/')
  expect(sessionPath(null, 'console')).toBe('/')
})
