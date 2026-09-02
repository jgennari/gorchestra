import type { AgentEvent, Session } from '@/lib/api'
import {
  clearSessionCacheForTest,
  deleteCachedSession,
  persistentCachedEventLimit,
  persistentCachedSingleEventBytesLimit,
  readCachedSession,
  readCachedSessionEvents,
  readCachedSessionEventsBefore,
  readCachedSessionSnapshot,
  readCachedSessionSnapshotBySlug,
  writeCachedSession,
  writeCachedSessionEvents,
  writeCachedSessionEventPage,
  writeCachedSessionSnapshot,
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
  expect(readCachedSessionSnapshot('sess_1')).toMatchObject({ id: 'sess_1', title: 'Session sess_1' })
})

test('session cache stores and reads sync session snapshots by slug', () => {
  writeCachedSessionSnapshot(session('sess_1', 'Write docs'))

  expect(readCachedSessionSnapshotBySlug('write-docs')).toMatchObject({ id: 'sess_1', title: 'Write docs' })
})

test('session cache updates stale sync slug aliases when titles change', () => {
  writeCachedSessionSnapshot(session('sess_1', 'Write docs'))
  writeCachedSessionSnapshot(session('sess_1', 'Review docs'))

  expect(readCachedSessionSnapshotBySlug('write-docs')).toBeNull()
  expect(readCachedSessionSnapshotBySlug('review-docs')).toMatchObject({ id: 'sess_1', title: 'Review docs' })
})

test('session cache evicts old sessions after the cache limit', async () => {
  for (let index = 1; index <= 51; index += 1) {
    await writeCachedSession(session(`sess_${index}`))
  }

  expect(await readCachedSession('sess_1')).toBeNull()
  expect(await readCachedSession('sess_51')).toMatchObject({ id: 'sess_51' })
  expect(readCachedSessionSnapshot('sess_1')).toBeNull()
  expect(readCachedSessionSnapshotBySlug('session-sess-1')).toBeNull()
  expect(readCachedSessionSnapshot('sess_51')).toMatchObject({ id: 'sess_51' })
})

test('session cache ignores malformed sync snapshot data', () => {
  window.localStorage.setItem('gorchestra.session-snapshots.v1', '{"sessions":"bad"}')

  expect(readCachedSessionSnapshot('sess_1')).toBeNull()
  expect(readCachedSessionSnapshotBySlug('write-docs')).toBeNull()
})

test('session cache delete removes sync snapshots and aliases', async () => {
  await writeCachedSession(session('sess_1', 'Write docs'))

  await deleteCachedSession('sess_1')

  expect(readCachedSessionSnapshot('sess_1')).toBeNull()
  expect(readCachedSessionSnapshotBySlug('write-docs')).toBeNull()
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

test('session cache restores the hot window without the paged event index', async () => {
  await writeCachedSessionEvents(
    'sess_1',
    [event(10, 'user.message.completed'), event(11, 'agent.message.completed')],
    true,
  )
  const db = await openFakeDB(5, () => undefined)
  await deleteFakeRecords(db, 'event-records', [eventRecordKey('sess_1', 10), eventRecordKey('sess_1', 11)])
  await deleteFakeRecords(db, 'event-meta', ['sess_1'])
  clearSessionCacheForTest()

  const cached = await readCachedSessionEvents('sess_1')

  expect(cached?.events.map((item) => item.seq)).toEqual([10, 11])
  expect(cached).toMatchObject({ lastSeq: 11, oldestSeq: 10, hasOlderEvents: true })
})

test('session cache excludes transient deltas while retaining the stream cursor', async () => {
  await writeCachedSessionEvents(
    'sess_1',
    [
      event(1, 'agent.message.completed', 'Durable'),
      { ...event(2, 'agent.message.delta', 'Live'), status: 'delta', transient: true },
    ],
    false,
    false,
    2,
  )

  const cached = await readCachedSessionEvents('sess_1')
  expect(cached?.events.map((item) => item.seq)).toEqual([1])
  expect(cached?.lastSeq).toBe(2)
  expect(cached?.oldestSeq).toBe(1)
  expect(cached?.hasOlderEvents).toBe(false)
})

test('session cache compacts oversized individual events without leaving a coverage hole', async () => {
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
  expect(cached?.events.map((item) => item.seq)).toEqual([1, 2, 3])
  expect(cached?.events[1].payload).toEqual({ _gorchestra_window_truncated: true })
  expect(cached?.lastSeq).toBe(3)
  expect(cached?.hasOlderEvents).toBe(false)
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

test('session event cache does not persist debug windows', async () => {
  await writeCachedSessionEvents('sess_1', [event(1, 'agent.message.completed', 'normal')], false)
  await writeCachedSessionEvents('sess_1', [event(2, 'agent.message.completed', 'debug')], false, true)

  expect((await readCachedSessionEvents('sess_1'))?.events.map((item) => item.seq)).toEqual([1])
  expect(await readCachedSessionEvents('sess_1', true)).toBeNull()
})

test('session cache v5 upgrade migrates old event windows and keeps session snapshots', async () => {
  const oldDB = await openFakeDB(2, (db) => {
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
  expect(await readCachedSessionEvents('sess_1')).toMatchObject({ lastSeq: 1, oldestSeq: 1 })

  await writeCachedSessionEvents('sess_1', [event(2)], false)
  expect(await readCachedSessionEvents('sess_1')).toMatchObject({ lastSeq: 2, oldestSeq: 1 })
})

test('session cache v5 lazily creates a hot window from the v4 paged index', async () => {
  const oldDB = await openFakeDB(4, (db) => {
    db.createObjectStore('sessions', { keyPath: 'id' })
    db.createObjectStore('events', { keyPath: 'sessionID' })
    const records = db.createObjectStore('event-records', { keyPath: 'key' })
    records.createIndex('by-session', 'sessionID')
    db.createObjectStore('event-meta', { keyPath: 'sessionID' })
  })
  const cachedEvent = event(7)
  await putFakeRecord(oldDB, 'event-records', {
    key: eventRecordKey('sess_1', 7),
    sessionID: 'sess_1',
    seq: 7,
    event: cachedEvent,
    bytes: new TextEncoder().encode(JSON.stringify(cachedEvent)).byteLength,
  })
  await putFakeRecord(oldDB, 'event-meta', {
    sessionID: 'sess_1',
    lastSeq: 7,
    hasOlderEvents: true,
    usedAt: Date.now(),
    bytes: new TextEncoder().encode(JSON.stringify(cachedEvent)).byteLength,
    coverage: [{ firstSeq: 7, lastSeq: 7 }],
  })
  clearSessionCacheForTest()

  expect(await readCachedSessionEvents('sess_1')).toMatchObject({ lastSeq: 7, oldestSeq: 7 })
  expect(await getFakeRecord(oldDB, 'event-hot-window', 'sess_1')).toMatchObject({ lastSeq: 7 })

  await deleteFakeRecords(oldDB, 'event-records', [eventRecordKey('sess_1', 7)])
  await deleteFakeRecords(oldDB, 'event-meta', ['sess_1'])
  clearSessionCacheForTest()
  expect(await readCachedSessionEvents('sess_1')).toMatchObject({ lastSeq: 7, oldestSeq: 7 })
})

test('session cache reuses previously fetched older page coverage', async () => {
  await writeCachedSessionEventPage('sess_1', [event(5), event(6)], {
    coverageFirstSeq: 5,
    coverageLastSeq: 6,
    serverLastSeq: 6,
    hasOlderEvents: true,
  })
  expect(await readCachedSessionEventsBefore('sess_1', 5)).toBeNull()

  await writeCachedSessionEventPage('sess_1', [event(1), event(2), event(3), event(4)], {
    coverageFirstSeq: 1,
    coverageLastSeq: 4,
    serverLastSeq: 6,
    hasOlderEvents: false,
  })

  const cached = await readCachedSessionEventsBefore('sess_1', 5)
  expect(cached?.events.map((item) => item.seq)).toEqual([1, 2, 3, 4])
  expect(cached?.hasOlderEvents).toBe(false)
  expect(cached?.lastSeq).toBe(6)
})

test('session cache no-ops when IndexedDB is unavailable', async () => {
  vi.stubGlobal('indexedDB', undefined)
  clearSessionCacheForTest()

  await expect(writeCachedSession(session('sess_1'))).resolves.toBeUndefined()
  await expect(readCachedSession('sess_1')).resolves.toMatchObject({ id: 'sess_1' })
  expect(readCachedSessionSnapshot('sess_1')).toMatchObject({ id: 'sess_1' })
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

function getFakeRecord(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<unknown> {
  return new Promise((resolve) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(undefined)
  })
}

function deleteFakeRecords(db: IDBDatabase, storeName: string, keys: IDBValidKey[]): Promise<void> {
  return new Promise((resolve) => {
    const transaction = db.transaction(storeName, 'readwrite')
    transaction.oncomplete = () => resolve()
    const store = transaction.objectStore(storeName)
    keys.forEach((key) => store.delete(key))
  })
}

function eventRecordKey(sessionID: string, seq: number) {
  return `${sessionID}:${String(seq).padStart(20, '0')}`
}

function session(id: string, title = `Session ${id}`): Session {
  return {
    id,
    title,
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
