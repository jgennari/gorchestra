import type { AgentEvent } from '@/lib/api'
import {
  clearClientEventStoreForTest,
  clientEventStoreStats,
  ingestClientEvent,
  invalidateClientSessionEventTails,
  publishClientSessionEvent,
  readClientSessionEvents,
  replaceClientLiveEvents,
  replaceClientSessionLiveEvents,
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
    tailHydrated: false,
  })
  unsubscribe()
})

test('hydrates a transcript tail and merges newer global events', () => {
  seedClientSessionEvents('sess_1', [event('sess_1', 8), event('sess_1', 9)], {
    lastSeq: 9,
    hasOlderEvents: true,
    tailHydrated: true,
    replace: true,
  })

  expect(ingestClientEvent(event('sess_1', 10))).toBe(true)
  expect(readClientSessionEvents('sess_1')?.events.map((item) => item.seq)).toEqual([8, 9, 10])
  expect(readClientSessionEvents('sess_1')?.tailHydrated).toBe(true)
})

test('invalidating stream continuity keeps history and cursors but later events do not certify a missing range', () => {
  seedClientSessionEvents('sess_1', [event('sess_1', 8)], { tailHydrated: true })
  seedClientSessionEvents('sess_2', [event('sess_2', 20)], { tailHydrated: true })
  invalidateClientSessionEventTails()
  expect(readClientSessionEvents('sess_1')).toMatchObject({ lastSeq: 8, tailHydrated: false })
  expect(readClientSessionEvents('sess_2')).toMatchObject({ lastSeq: 20, tailHydrated: false })
  ingestClientEvent(event('sess_1', 10))
  expect(readClientSessionEvents('sess_1')?.events.map((item) => item.seq)).toEqual([8, 10])
  expect(readClientSessionEvents('sess_1')?.tailHydrated).toBe(false)
  seedClientSessionEvents('sess_1', [event('sess_1', 8), event('sess_1', 9)], { tailHydrated: true })
  expect(readClientSessionEvents('sess_1')?.events.map((item) => item.seq)).toEqual([8, 9, 10])
  expect(readClientSessionEvents('sess_2')?.tailHydrated).toBe(false)
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

test('accumulates background transient events without advancing the durable cursor', () => {
  seedClientSessionEvents('sess_1', [event('sess_1', 8)], { lastSeq: 8, replace: true })
  const first = { ...event('sess_1', 9), id: 'delta_1', type: 'agent.message.delta', transient: true, payload: { message_id: 'msg_1', text: 'Hello ' } }
  const second = { ...event('sess_1', 10), id: 'delta_2', type: 'agent.message.delta', transient: true, payload: { message_id: 'msg_1', text: 'world' } }

  expect(ingestClientEvent(first)).toBe(true)
  expect(ingestClientEvent(second)).toBe(true)
  const snapshot = readClientSessionEvents('sess_1')
  expect(snapshot?.lastSeq).toBe(8)
  expect(snapshot?.events.find((item) => item.type === 'agent.message.delta')?.payload).toMatchObject({ text: 'Hello world' })
})

test('durable lifecycle events preserve live output until its completion arrives', () => {
  ingestClientEvent({
    ...event('sess_1', 2), id: 'delta_1', type: 'agent.message.delta', transient: true,
    payload: { message_id: 'msg_1', text: 'Streaming' },
  })
  ingestClientEvent({ ...event('sess_1', 3), type: 'agent.status.started' })
  expect(readClientSessionEvents('sess_1')?.events.some((item) => item.type === 'agent.message.delta')).toBe(true)

  ingestClientEvent({
    ...event('sess_1', 4), type: 'agent.message.completed', payload: { message_id: 'msg_1', text: 'Streaming done' },
  })
  expect(readClientSessionEvents('sess_1')?.events.some((item) => item.type === 'agent.message.delta')).toBe(false)
})

test('authoritative live snapshot replaces an incomplete local prefix', () => {
  seedClientSessionEvents('sess_1', [event('sess_1', 8)], { lastSeq: 8, replace: true })
  ingestClientEvent({ ...event('sess_1', 10), id: 'delta_2', type: 'agent.message.delta', transient: true, payload: { message_id: 'msg_1', text: 'world' } })

  replaceClientLiveEvents([
    { ...event('sess_1', 10), id: 'snapshot_1', type: 'agent.message.delta', transient: true, payload: { message_id: 'msg_1', text: 'Hello world' } },
  ], { sess_1: 10 })

  expect(ingestClientEvent({
    ...event('sess_1', 9), id: 'queued_old', type: 'agent.message.delta', transient: true,
    payload: { message_id: 'msg_1', text: ' duplicated' },
  })).toBe(false)
  expect(ingestClientEvent({
    ...event('sess_1', 11), id: 'delta_new', type: 'agent.message.delta', transient: true,
    payload: { message_id: 'msg_1', text: '!' },
  })).toBe(true)

  const deltas = readClientSessionEvents('sess_1')?.events.filter((item) => item.type === 'agent.message.delta') ?? []
  expect(deltas).toHaveLength(1)
  expect(deltas[0].payload).toMatchObject({ text: 'Hello world!' })
})

test('history hydration cannot replace a complete live snapshot with its transient suffix', () => {
  seedClientSessionEvents('sess_1', [event('sess_1', 8)], { lastSeq: 8, replace: true })
  replaceClientLiveEvents([
    { ...event('sess_1', 10), id: 'snapshot_1', type: 'agent.message.delta', transient: true, payload: { message_id: 'msg_1', text: 'Hello world' } },
  ], { sess_1: 10 })

  seedClientSessionEvents('sess_1', [
    event('sess_1', 8),
    { ...event('sess_1', 10), id: 'history_tail', type: 'agent.message.delta', transient: true, payload: { message_id: 'msg_1', text: 'world' } },
  ], { lastSeq: 8, tailHydrated: true, replace: true })

  const snapshot = readClientSessionEvents('sess_1')
  expect(snapshot?.events.filter((item) => item.type === 'agent.message.delta')).toHaveLength(1)
  expect(snapshot?.events.find((item) => item.type === 'agent.message.delta')?.payload).toMatchObject({ text: 'Hello world' })
  expect(snapshot?.tailHydrated).toBe(true)
})

test('session snapshot retains deltas that raced ahead of its watermark', () => {
  ingestClientEvent({ ...event('sess_1', 9), id: 'delta_old_1', type: 'agent.message.delta', transient: true, payload: { message_id: 'msg_1', text: 'Hello ' } })
  ingestClientEvent({ ...event('sess_1', 10), id: 'delta_old_2', type: 'agent.message.delta', transient: true, payload: { message_id: 'msg_1', text: 'world' } })
  ingestClientEvent({ ...event('sess_1', 12), id: 'delta_new', type: 'agent.message.delta', transient: true, payload: { message_id: 'msg_1', text: '!' } })
  replaceClientSessionLiveEvents('sess_1', [{
    ...event('sess_1', 10), id: 'snapshot_1', type: 'agent.message.delta', transient: true,
    payload: { message_id: 'msg_1', text: 'Hello world' },
  }], 10)

  const delta = readClientSessionEvents('sess_1')?.events.find((item) => item.type === 'agent.message.delta')
  expect(delta?.payload).toMatchObject({ text: 'Hello world!' })
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
