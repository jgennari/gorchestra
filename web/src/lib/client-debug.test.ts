import type { AgentEvent } from '@/lib/api'
import { clientDebugEnabled, clientDebugURL, debugEventMetadata, debugTime, latestDebugMessage } from '@/lib/client-debug'

test.each(['?debug=1', '?debug=true', '?debug-scroll=1', '?viewportDebug=true', '?viewportDebug=1'])('enables the generic debug view for %s', (search) => {
  expect(clientDebugEnabled(search)).toBe(true)
})

test.each(['', '?debug=0', '?debug-scroll=false', '?event_seq=1', '?debug=anything'])('does not enable debug for %s', (search) => {
  expect(clientDebugEnabled(search)).toBe(false)
})

test('canonicalizes debug URLs without losing history/file targets or hashes', () => {
  expect(clientDebugURL('/sessions/test?event_seq=7&debug-scroll=1#anchor', true))
    .toBe('/sessions/test?event_seq=7&debug=1#anchor')
  expect(clientDebugURL('/sessions/test/files/a.ts?line=3&viewportDebug=true&debug=1', false))
    .toBe('/sessions/test/files/a.ts?line=3')
})

test('SSE diagnostics keep metadata only and label transient events', () => {
  const metadata = debugEventMetadata(event(4, 'agent.message.delta', { text: 'private tool args' }, true))
  expect(metadata).toMatchObject({ seq: 4, cursor: 14, session: 'session-a', transient: true })
  expect(JSON.stringify(metadata)).not.toContain('private tool args')
})

test('last message comes from the newest loaded window with bounded text', () => {
  const result = latestDebugMessage([event(2, 'user.message.completed', { text: 'old' })], [
    event(3, 'agent.message.completed', { text: 'long '.repeat(100) }),
    event(4, 'tool.call.completed', { text: 'not a message' }),
  ])
  expect(result.message).toContain('agent #3')
  expect(result.preview.length).toBeLessThanOrEqual(161)
  expect(result.preview.endsWith('…')).toBe(true)
  expect(latestDebugMessage([event(1, 'user.message.completed', null)]).preview).toBe('(no text)')
  expect(latestDebugMessage([]).message).toContain('No completed message')
})

test('debug timestamps tolerate missing and invalid values', () => {
  expect(debugTime(0)).toBe('none')
  expect(debugTime('invalid')).toBe('none')
  expect(debugTime(1000, 3500)).toContain('(2s ago)')
})

function event(seq: number, type: string, payload: unknown, transient = false): AgentEvent {
  return { id: `event-${seq}`, session_id: 'session-a', seq, global_seq: seq + 10, type, payload, transient, role: 'assistant', status: 'completed', created_at: '2026-09-07T12:00:00Z' }
}
