import type { AgentEvent } from '@/lib/api'
import {
  clearClientEventStoreForTest,
  clientEventStoreStats,
  ingestClientEvent,
  publishClientSessionEvent,
  readClientSessionEvents,
  seedClientSessionEvents,
  subscribeClientSessionEvents,
} from '@/lib/client-event-store'

vi.mock('@/lib/session-cache', () => ({
  writeCachedSessionEvent: vi.fn(async () => undefined),
}))

beforeEach(() => clearClientEventStoreForTest())

test('deduplicates transports by session sequence and notifies once', () => {
  const listener = vi.fn()
  const unsubscribe = subscribeClientSessionEvents('sess_1', listener)
  const update = event('sess_1', 2)

  expect(ingestClientEvent(update)).toBe(true)
  expect(ingestClientEvent({ ...update, global_seq: 99 })).toBe(false)
  expect(listener).toHaveBeenCalledTimes(1)
  expect(readClientSessionEvents('sess_1')).toMatchObject({
    events: [update],
    lastSeq: 2,
    oldestSeq: 2,
    hasOlderEvents: true,
  })
  unsubscribe()
})

test('hydrates a transcript tail and merges newer global events', () => {
  seedClientSessionEvents('sess_1', [event('sess_1', 8), event('sess_1', 9)], {
    lastSeq: 9,
    hasOlderEvents: true,
    replace: true,
  })

  expect(ingestClientEvent(event('sess_1', 10))).toBe(true)
  expect(readClientSessionEvents('sess_1')?.events.map((item) => item.seq)).toEqual([8, 9, 10])
})

test('publishes transient events without caching or advancing the durable cursor', () => {
  const listener = vi.fn()
  subscribeClientSessionEvents('sess_1', listener)
  seedClientSessionEvents('sess_1', [event('sess_1', 8)], { lastSeq: 8, replace: true })
  const transient = { ...event('sess_1', 9), type: 'agent.message.delta', transient: true }

  expect(publishClientSessionEvent(transient)).toBe(true)
  expect(listener).toHaveBeenCalledWith(transient, expect.objectContaining({ lastSeq: 8 }))
  expect(readClientSessionEvents('sess_1')?.events.map((item) => item.seq)).toEqual([8])
  expect(readClientSessionEvents('sess_1')?.lastSeq).toBe(8)
})

test('evicts cold transcript windows while retaining their sequence cursors', () => {
  for (let index = 1; index <= 51; index += 1) {
    expect(ingestClientEvent(event(`sess_${index}`, 5))).toBe(true)
  }

  expect(clientEventStoreStats()).toMatchObject({ sessions: 50, cursors: 51 })
  expect(readClientSessionEvents('sess_1')).toBeNull()
  expect(ingestClientEvent(event('sess_1', 5))).toBe(false)
  expect(ingestClientEvent(event('sess_1', 6))).toBe(true)
})

function event(sessionID: string, seq: number): AgentEvent {
  return {
    id: `${sessionID}_${seq}`,
    session_id: sessionID,
    seq,
    type: 'agent.message.completed',
    role: 'assistant',
    status: 'completed',
    payload: { text: `event ${seq}` },
    created_at: '2026-09-04T12:00:00Z',
  }
}
