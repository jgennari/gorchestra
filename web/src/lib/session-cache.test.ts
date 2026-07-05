import type { AgentEvent, Session } from '@/lib/api'
import {
  clearSessionCacheForTest,
  persistentCachedEventLimit,
  persistentCachedSingleEventBytesLimit,
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

test('session cache drops oversized individual events from persisted event windows', async () => {
  await writeCachedSessionEvents(
    'sess_1',
    [
      event(1, 'agent.message.completed', 'small before'),
      event(2, 'tool.call.completed', 'x'.repeat(persistentCachedSingleEventBytesLimit + 1024)),
      event(3, 'agent.message.completed', 'small after'),
    ],
    false,
  )

  const cached = await readCachedSessionEvents('sess_1')
  expect(cached?.events.map((item) => item.seq)).toEqual([1, 3])
  expect(cached?.lastSeq).toBe(3)
  expect(cached?.hasOlderEvents).toBe(true)
})

test('session event cache remains enabled on iOS browsers', async () => {
  const originalUserAgent = navigator.userAgent
  const originalPlatform = navigator.platform
  const originalMaxTouchPoints = navigator.maxTouchPoints
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  })
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'iPhone' })
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 })

  await writeCachedSessionEvents('sess_1', [event(1)], false)

  expect(await readCachedSessionEvents('sess_1')).toMatchObject({ lastSeq: 1, oldestSeq: 1 })

  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent })
  Object.defineProperty(navigator, 'platform', { configurable: true, value: originalPlatform })
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: originalMaxTouchPoints })
})

test('session cache v2 upgrade clears old event windows but keeps session snapshots', async () => {
  const oldDB = await openFakeDB(1, (db) => {
    db.createObjectStore('sessions')
    db.createObjectStore('events')
  })
  await putFakeRecord(oldDB, 'sessions', { id: 'sess_1', session: session('sess_1'), usedAt: Date.now() })
  await putFakeRecord(oldDB, 'events', {
    sessionID: 'sess_1',
    events: [event(1)],
    lastSeq: 1,
    oldestSeq: 1,
    hasOlderEvents: false,
    usedAt: Date.now(),
  })
  clearSessionCacheForTest()

  expect(await readCachedSession('sess_1')).toMatchObject({ id: 'sess_1' })
  expect(await readCachedSessionEvents('sess_1')).toBeNull()

  await writeCachedSessionEvents('sess_1', [event(2)], false)
  expect(await readCachedSessionEvents('sess_1')).toMatchObject({ lastSeq: 2, oldestSeq: 2 })
})

test('session cache no-ops when IndexedDB is unavailable', async () => {
  vi.stubGlobal('indexedDB', undefined)
  clearSessionCacheForTest()

  await expect(writeCachedSession(session('sess_1'))).resolves.toBeUndefined()
  await expect(readCachedSession('sess_1')).resolves.toBeNull()
})

function openFakeDB(version: number, onUpgrade: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = fakeIndexedDB.open('gorchestra-session-cache', version) as unknown as IDBOpenDBRequest
    request.onerror = () => reject(new Error('failed to open fake IndexedDB'))
    request.onupgradeneeded = () => {
      onUpgrade(request.result)
    }
    request.onsuccess = () => resolve(request.result)
  })
}

function putFakeRecord(db: IDBDatabase, storeName: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    const transaction = db.transaction(storeName, 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.objectStore(storeName).put(value)
  })
}

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

function event(seq: number, type = 'agent.message.completed', text = `event ${seq}`): AgentEvent {
  return {
    id: `evt_${seq}`,
    session_id: 'sess_1',
    seq,
    type,
    role: 'assistant',
    status: 'completed',
    payload: { text },
    created_at: '2026-06-12T16:00:00Z',
  }
}
