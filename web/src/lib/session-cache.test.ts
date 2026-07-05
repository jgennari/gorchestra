import type { AgentEvent, Session } from '@/lib/api'
import {
  clearSessionCacheForTest,
  persistentCachedEventLimit,
  readCachedSession,
  readCachedSessionEvents,
  writeCachedSession,
  writeCachedSessionEvents,
} from '@/lib/session-cache'
import { createFakeIndexedDB } from '@/test/fake-indexeddb'

let fakeIndexedDB: ReturnType<typeof createFakeIndexedDB>

beforeEach(() => {
  clearSessionCacheForTest()
  fakeIndexedDB = createFakeIndexedDB()
  vi.stubGlobal('indexedDB', fakeIndexedDB)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('session cache stores and reads session snapshots', async () => {
  await writeCachedSession(session('sess_1'))

  expect(await readCachedSession('sess_1')).toMatchObject({ id: 'sess_1', title: 'Session sess_1' })
})

test('session cache evicts old sessions after the cache limit', async () => {
  for (let index = 1; index <= 9; index += 1) {
    await writeCachedSession(session(`sess_${index}`))
  }

  expect(await readCachedSession('sess_1')).toBeNull()
  expect(await readCachedSession('sess_9')).toMatchObject({ id: 'sess_9' })
})

test('session cache stores a trimmed recent event window', async () => {
  const events = Array.from({ length: persistentCachedEventLimit + 2 }, (_, index) =>
    event(index + 1, index === 1 ? 'agent.message.delta' : 'agent.message.completed'),
  )

  await writeCachedSessionEvents('sess_1', events, false)

  const cached = await readCachedSessionEvents('sess_1')
  expect(cached?.events).toHaveLength(persistentCachedEventLimit)
  expect(cached?.events[0].seq).toBe(3)
  expect(cached?.lastSeq).toBe(persistentCachedEventLimit + 2)
  expect(cached?.hasOlderEvents).toBe(true)
})

test('session cache no-ops when IndexedDB is unavailable', async () => {
  vi.stubGlobal('indexedDB', undefined)
  clearSessionCacheForTest()

  await expect(writeCachedSession(session('sess_1'))).resolves.toBeUndefined()
  await expect(readCachedSession('sess_1')).resolves.toBeNull()
})

function session(id: string): Session {
  return {
    id,
    title: `Session ${id}`,
    agent_type: 'fake',
    status: 'idle',
    workspace_path: '/repo',
    event_count: 0,
    tool_count: 0,
    created_at: '2026-06-12T16:00:00Z',
    updated_at: '2026-06-12T16:00:00Z',
    completed_at: null,
    archived_at: null,
  }
}

function event(seq: number, type: string): AgentEvent {
  return {
    id: `evt_${seq}`,
    session_id: 'sess_1',
    seq,
    type,
    role: 'assistant',
    status: 'completed',
    payload: { text: `event ${seq}` },
    created_at: '2026-06-12T16:00:00Z',
  }
}
