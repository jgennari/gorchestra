import {
  sessionIDFromPathname,
  sessionPath,
  sessionRouteFromPathname,
  sessionSlugPath,
  sessionTitleSlug,
} from '@/lib/routes'

test('session route helpers parse and build session paths', () => {
  expect(sessionIDFromPathname('/sessions/sess_123')).toBe('sess_123')
  expect(sessionIDFromPathname('/sessions/sess_%2Fencoded/events')).toBe('sess_/encoded')
  expect(sessionIDFromPathname('/')).toBeNull()
  expect(sessionIDFromPathname('/sessions/')).toBeNull()
  expect(sessionIDFromPathname('/sessions/%E0%A4%A')).toBeNull()

  expect(sessionRouteFromPathname('/sessions/sess_123')).toEqual({
    sessionID: 'sess_123',
    sessionSlug: null,
    view: 'session',
    filePath: null,
  })
  expect(sessionRouteFromPathname('/sessions/sess_123/console')).toEqual({
    sessionID: 'sess_123',
    sessionSlug: null,
    view: 'console',
    filePath: null,
  })
  expect(sessionRouteFromPathname('/sessions/sess_123/schedules')).toEqual({
    sessionID: 'sess_123',
    sessionSlug: null,
    view: 'schedules',
    filePath: null,
  })
  expect(sessionRouteFromPathname('/sessions/sess_123/skills')).toEqual({
    sessionID: 'sess_123',
    sessionSlug: null,
    view: 'skills',
    filePath: null,
  })
  expect(sessionRouteFromPathname('/sessions/sess_123/files')).toEqual({
    sessionID: 'sess_123',
    sessionSlug: null,
    view: 'files',
    filePath: null,
  })
  expect(sessionRouteFromPathname('/sessions/sess_123/host')).toEqual({
    sessionID: 'sess_123',
    sessionSlug: null,
    view: 'host',
    filePath: null,
  })
  expect(sessionRouteFromPathname('/sessions/sess_123/files/src%2Fmain.go')).toEqual({
    sessionID: 'sess_123',
    sessionSlug: null,
    view: 'files',
    filePath: 'src/main.go',
  })
  expect(sessionRouteFromPathname('/sessions/sess_123/events')).toEqual({
    sessionID: 'sess_123',
    sessionSlug: null,
    view: 'session',
    filePath: null,
  })
  expect(sessionRouteFromPathname('/sessions/gorchestra-ui')).toEqual({
    sessionID: null,
    sessionSlug: 'gorchestra-ui',
    view: 'session',
    filePath: null,
  })
  expect(sessionRouteFromPathname('/sessions/gorchestra-ui/console')).toEqual({
    sessionID: null,
    sessionSlug: 'gorchestra-ui',
    view: 'console',
    filePath: null,
  })
  expect(sessionRouteFromPathname('/sessions/gorchestra-ui/files')).toEqual({
    sessionID: null,
    sessionSlug: 'gorchestra-ui',
    view: 'files',
    filePath: null,
  })
  expect(sessionRouteFromPathname('/sessions/gorchestra-ui/files/src%2Fmain.go')).toEqual({
    sessionID: null,
    sessionSlug: 'gorchestra-ui',
    view: 'files',
    filePath: 'src/main.go',
  })
  expect(sessionRouteFromPathname('/')).toEqual({ sessionID: null, sessionSlug: null, view: 'session', filePath: null })

  expect(sessionPath('sess_123')).toBe('/sessions/sess_123')
  expect(sessionPath('sess_123', 'console')).toBe('/sessions/sess_123/console')
  expect(sessionPath('sess_123', 'schedules')).toBe('/sessions/sess_123/schedules')
  expect(sessionPath('sess_123', 'skills')).toBe('/sessions/sess_123/skills')
  expect(sessionPath('sess_123', 'files')).toBe('/sessions/sess_123/files')
  expect(sessionPath('sess_123', 'host')).toBe('/sessions/sess_123/host')
  expect(sessionPath('sess_123', 'files', 'src/main.go')).toBe('/sessions/sess_123/files/src%2Fmain.go')
  expect(sessionPath('sess_/encoded')).toBe('/sessions/sess_%2Fencoded')
  expect(sessionPath(null)).toBe('/')
  expect(sessionPath(null, 'console')).toBe('/')
  expect(sessionSlugPath('gorchestra-ui')).toBe('/sessions/gorchestra-ui')
  expect(sessionSlugPath('gorchestra-ui', 'files')).toBe('/sessions/gorchestra-ui/files')
  expect(sessionSlugPath('gorchestra-ui', 'files', 'src/main.go')).toBe('/sessions/gorchestra-ui/files/src%2Fmain.go')
  expect(sessionTitleSlug('Gorchestra UI')).toBe('gorchestra-ui')
  expect(sessionTitleSlug('  Claude + OpenCode support!  ')).toBe('claude-opencode-support')
  expect(sessionTitleSlug('')).toBe('untitled-session')
})
