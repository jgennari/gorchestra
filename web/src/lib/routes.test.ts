import { sessionIDFromPathname, sessionPath } from '@/lib/routes'

test('session route helpers parse and build session paths', () => {
  expect(sessionIDFromPathname('/sessions/sess_123')).toBe('sess_123')
  expect(sessionIDFromPathname('/sessions/sess_%2Fencoded/events')).toBe('sess_/encoded')
  expect(sessionIDFromPathname('/')).toBeNull()
  expect(sessionIDFromPathname('/sessions/')).toBeNull()
  expect(sessionIDFromPathname('/sessions/%E0%A4%A')).toBeNull()

  expect(sessionPath('sess_123')).toBe('/sessions/sess_123')
  expect(sessionPath('sess_/encoded')).toBe('/sessions/sess_%2Fencoded')
  expect(sessionPath(null)).toBe('/')
})
