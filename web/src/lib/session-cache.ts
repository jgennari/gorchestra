import type { AgentEvent, Session } from '@/lib/api'
import { isTransientEvent } from '@/lib/events'
import { boundEventWindow, cachedEventWindowPolicy } from '@/lib/session-event-window'
import { sessionTitleSlug } from '@/lib/routes'

export type CachedSessionEvents = {
  events: AgentEvent[]
  lastSeq: number
  oldestSeq: number
  hasOlderEvents: boolean
}

export type CachedSessionEventPageOptions = {
  coverageFirstSeq?: number
  coverageLastSeq?: number
  serverLastSeq?: number
  hasOlderEvents?: boolean
  updateHotWindow?: boolean
}

export type PersistentStorageStatus = 'persisted' | 'best-effort' | 'unavailable'

type CachedSessionRecord = {
  id: string
  session: Session
  usedAt: number
}

type LegacyCachedSessionEventsRecord = CachedSessionEvents & {
  sessionID: string
  usedAt: number
}

type CachedEventRecord = {
  key: string
  sessionID: string
  seq: number
  event: AgentEvent
  bytes: number
}

type CachedEventCoverage = {
  firstSeq: number
  lastSeq: number
}

type CachedEventMeta = {
  sessionID: string
  lastSeq: number
  hasOlderEvents: boolean
  usedAt: number
  bytes: number
  coverage: CachedEventCoverage[]
}

type CachedEventHotWindow = CachedSessionEvents & {
  sessionID: string
  usedAt: number
  bytes: number
}

type SyncCachedSessionRecord = CachedSessionRecord & {
  slug: string
}

type SyncCachedSessions = {
  sessions: SyncCachedSessionRecord[]
  aliases: Record<string, string>
}

const dbName = 'gorchestra-session-cache'
const dbVersion = 5
const sessionsStore = 'sessions'
const legacyEventsStore = 'events'
const eventRecordsStore = 'event-records'
const eventRecordsSessionIndex = 'by-session'
const eventMetaStore = 'event-meta'
const eventHotWindowStore = 'event-hot-window'
const cachedSessionLimit = 50
const syncSessionCacheStorageKey = 'gorchestra.session-snapshots.v1'
export const persistentCachedEventLimit = 1000
export const persistentCachedEventBytesLimit = 32 * 1024 * 1024
export const persistentGlobalEventBytesLimit = 64 * 1024 * 1024
export const persistentCachedSingleEventBytesLimit = 2 * 1024 * 1024
const persistentHotWindowBytesLimit = 32 * 1024 * 1024
const persistentHotWindowLimit = 50

let dbPromise: Promise<IDBDatabase | null> | null = null
let storagePersistencePromise: Promise<PersistentStorageStatus> | null = null
let eventWriteQueue: Promise<void> = Promise.resolve()
const eventWriteQueues = new Map<string, Promise<void>>()

export function readCachedSessionSnapshot(sessionID: string): Session | null {
  if (!sessionID) return null
  return readSyncSessionCache().sessions.find((record) => record.id === sessionID)?.session ?? null
}

export function readCachedSessionSnapshotBySlug(slug: string): Session | null {
  if (!slug) return null
  const cache = readSyncSessionCache()
  const sessionID = cache.aliases[slug]
  if (!sessionID) return null
  return cache.sessions.find((record) => record.id === sessionID)?.session ?? null
}

export function writeCachedSessionSnapshot(session: Session): void {
  writeSyncSessionCache(upsertSyncSession(readSyncSessionCache(), session))
}

export function writeCachedSessionSnapshots(sessions: Session[]): void {
  let cache = readSyncSessionCache()
  const usedAtBase = Date.now()
  for (const [index, session] of sessions.entries()) {
    cache = upsertSyncSession(cache, session, usedAtBase + sessions.length - index)
  }
  writeSyncSessionCache(cache)
}

export function deleteCachedSessionSnapshot(sessionID: string): void {
  if (!sessionID) return
  const sessions = readSyncSessionCache().sessions.filter((record) => record.id !== sessionID)
  writeSyncSessionCache({ sessions, aliases: aliasesForSessions(sessions) })
}

export async function readCachedSession(sessionID: string): Promise<Session | null> {
  const db = await openCacheDB()
  if (!db) return readCachedSessionSnapshot(sessionID)

  const record = await getRecord<CachedSessionRecord>(db, sessionsStore, sessionID)
  if (!record) return readCachedSessionSnapshot(sessionID)

  await putRecord(db, sessionsStore, { ...record, usedAt: Date.now() })
  writeCachedSessionSnapshot(record.session)
  return record.session
}

export async function writeCachedSession(session: Session): Promise<void> {
  writeCachedSessionSnapshot(session)
  const db = await openCacheDB()
  if (!db) return

  await putRecord(db, sessionsStore, { id: session.id, session, usedAt: Date.now() })
  await evictOldRecords(db, sessionsStore, cachedSessionLimit)
}

export async function writeCachedSessions(sessions: Session[]): Promise<void> {
  writeCachedSessionSnapshots(sessions)
  const db = await openCacheDB()
  if (!db) return

  const usedAtBase = Date.now()
  await putRecords(
    db,
    sessionsStore,
    sessions.map((session, index) => ({
      id: session.id,
      session,
      usedAt: usedAtBase + sessions.length - index,
    })),
  )
  await evictOldRecords(db, sessionsStore, cachedSessionLimit)
}

export async function deleteCachedSession(sessionID: string): Promise<void> {
  deleteCachedSessionSnapshot(sessionID)
  const db = await openCacheDB()
  if (!db) return

  await deleteSessionEventRecords(db, sessionID)
  await Promise.all([
    deleteRecord(db, sessionsStore, sessionID),
    deleteRecord(db, eventMetaStore, sessionID),
    deleteRecord(db, eventHotWindowStore, sessionID),
    deleteRecord(db, legacyEventsStore, sessionID),
    deleteRecord(db, legacyEventsStore, legacySessionEventsCacheKey(sessionID, false)),
    deleteRecord(db, legacyEventsStore, legacySessionEventsCacheKey(sessionID, true)),
  ])
}

export async function readCachedSessionEvents(
  sessionID: string,
  includeDebugEvents = false,
): Promise<CachedSessionEvents | null> {
  if (includeDebugEvents) return null
  await waitForSessionWrites(sessionID)
  const db = await openCacheDB()
  if (!db) return null

  const [hotWindow, currentMeta] = await Promise.all([
    getRecord<CachedEventHotWindow>(db, eventHotWindowStore, sessionID),
    getRecord<CachedEventMeta>(db, eventMetaStore, sessionID),
  ])
  if (
    isCachedEventHotWindow(hotWindow, sessionID) &&
    (!currentMeta || hotWindow.lastSeq >= currentMeta.lastSeq)
  ) {
    const cached = cachedSessionEventsFromHotWindow(hotWindow)
    void touchCachedEventMeta(db, sessionID)
    return cached
  }

  let meta = currentMeta
  if (!meta) {
    try {
      meta = await migrateLegacySessionEvents(db, sessionID)
    } catch (error) {
      console.warn('Unable to migrate the previous session event cache.', error)
      return null
    }
  }
  if (!meta) return null

  const records = await getLatestSessionEventRecords(
    db,
    sessionID,
    Number.MAX_SAFE_INTEGER,
    1,
    cachedEventWindowPolicy.maxTurns,
    cachedEventWindowPolicy.maxDurableEvents,
    cachedEventWindowPolicy.maxBytes,
  )
  if (records.length === 0) {
    const cached = { events: [], lastSeq: meta.lastSeq, oldestSeq: 0, hasOlderEvents: false }
    void Promise.all([
      putCachedEventHotWindow(db, sessionID, cached.events, {
        serverLastSeq: cached.lastSeq,
        hasOlderEvents: cached.hasOlderEvents,
      }),
      putRecord(db, eventMetaStore, { ...meta, usedAt: Date.now() }),
    ]).catch(() => undefined)
    return cached
  }
  const bounded = boundEventWindow(
    records.map((record) => record.event),
    'latest',
    cachedEventWindowPolicy,
  )
  if (bounded.events.length === 0) return null

  const oldestSeq = firstSeq(bounded.events)
  const cached = {
    events: bounded.events,
    lastSeq: Math.max(meta.lastSeq, lastSeq(bounded.events)),
    oldestSeq,
    hasOlderEvents: meta.hasOlderEvents || bounded.trimmedStart || oldestSeq > 1,
  }
  void Promise.all([
    putCachedEventHotWindow(db, sessionID, cached.events, {
      coverageFirstSeq: cached.oldestSeq,
      coverageLastSeq: cached.lastSeq,
      serverLastSeq: cached.lastSeq,
      hasOlderEvents: cached.hasOlderEvents,
    }),
    putRecord(db, eventMetaStore, { ...meta, usedAt: Date.now() }),
  ]).catch(() => undefined)
  return cached
}

export async function readCachedSessionEventsBefore(
  sessionID: string,
  beforeSeq: number,
  turns = 25,
  maxBytes = 1024 * 1024,
  includeDebugEvents = false,
): Promise<CachedSessionEvents | null> {
  if (includeDebugEvents || beforeSeq <= 1) return null
  await waitForSessionWrites(sessionID)
  const db = await openCacheDB()
  if (!db) return null

  const meta = await getRecord<CachedEventMeta>(db, eventMetaStore, sessionID)
  if (!meta) return null
  const coverage = meta.coverage.find((range) => range.firstSeq < beforeSeq && range.lastSeq >= beforeSeq - 1)
  if (!coverage) return null

  const records = await getLatestSessionEventRecords(
    db,
    sessionID,
    beforeSeq,
    coverage.firstSeq,
    Math.max(1, turns),
    cachedEventWindowPolicy.maxDurableEvents,
    Math.max(1, maxBytes),
  )
  if (records.length === 0) return null
  const bounded = boundEventWindow(
    records.map((record) => record.event),
    'latest',
    {
      ...cachedEventWindowPolicy,
      maxTurns: Math.max(1, turns),
      maxBytes: Math.max(1, maxBytes),
    },
  )
  if (bounded.events.length === 0) return null

  const oldestSeq = firstSeq(bounded.events)
  await putRecord(db, eventMetaStore, { ...meta, usedAt: Date.now() })
  return {
    events: bounded.events,
    lastSeq: meta.lastSeq,
    oldestSeq,
    hasOlderEvents: bounded.trimmedStart || oldestSeq > 1,
  }
}

export async function writeCachedSessionEvents(
  sessionID: string,
  events: AgentEvent[],
  hasOlderEvents: boolean,
  includeDebugEvents = false,
  cursorSeq = lastSeq(events),
): Promise<void> {
  return writeCachedSessionEventPage(
    sessionID,
    events,
    {
      coverageFirstSeq: firstSeq(events),
      coverageLastSeq: cursorSeq,
      serverLastSeq: cursorSeq,
      hasOlderEvents,
    },
    includeDebugEvents,
  )
}

export async function writeCachedSessionEventPage(
  sessionID: string,
  events: AgentEvent[],
  options: CachedSessionEventPageOptions = {},
  includeDebugEvents = false,
): Promise<void> {
  if (includeDebugEvents || !sessionID) return
  return enqueueSessionWrite(sessionID, async () => {
    const db = await openCacheDB()
    if (!db) return
    try {
      if (options.updateHotWindow !== false) {
        await putCachedEventHotWindow(db, sessionID, events, options)
      }
      await writeCachedSessionEventPageNow(db, sessionID, events, options)
      await enforceEventStorageBudgets(db, sessionID)
    } catch (error) {
      await freeEventStorageForRetry(db, sessionID)
      try {
        if (options.updateHotWindow !== false) {
          await putCachedEventHotWindow(db, sessionID, events, options)
        }
        await writeCachedSessionEventPageNow(db, sessionID, events, options)
        await enforceEventStorageBudgets(db, sessionID)
      } catch (retryError) {
        console.warn('Unable to persist the session event cache after retrying.', retryError ?? error)
      }
    }
  })
}

export async function writeCachedSessionEvent(
  sessionID: string,
  event: AgentEvent,
  serverLastSeq = event.seq,
  includeDebugEvents = false,
): Promise<void> {
  return writeCachedSessionEventPage(
    sessionID,
    [event],
    {
      coverageFirstSeq: event.seq,
      coverageLastSeq: event.seq,
      serverLastSeq,
      updateHotWindow: false,
    },
    includeDebugEvents,
  )
}

export async function writeCachedSessionEventWindow(
  sessionID: string,
  events: AgentEvent[],
  hasOlderEvents: boolean,
  cursorSeq = lastSeq(events),
  includeDebugEvents = false,
): Promise<void> {
  if (includeDebugEvents || !sessionID) return
  const db = await openCacheDB()
  if (!db) return
  const options = {
    coverageFirstSeq: firstSeq(events),
    coverageLastSeq: cursorSeq,
    serverLastSeq: cursorSeq,
    hasOlderEvents,
  }
  try {
    await putCachedEventHotWindow(db, sessionID, events, options)
  } catch (error) {
    await freeHotWindowStorageForRetry(db, sessionID)
    try {
      await putCachedEventHotWindow(db, sessionID, events, options)
    } catch (retryError) {
      console.warn('Unable to persist the recent session window after retrying.', retryError ?? error)
    }
  }
}

export async function ensurePersistentSessionStorage(): Promise<PersistentStorageStatus> {
  storagePersistencePromise ??= requestPersistentSessionStorage()
  return storagePersistencePromise
}

export function clearSessionCacheForTest() {
  dbPromise = null
  storagePersistencePromise = null
  eventWriteQueue = Promise.resolve()
  eventWriteQueues.clear()
  if (typeof window !== 'undefined') window.localStorage.removeItem(syncSessionCacheStorageKey)
}

async function requestPersistentSessionStorage(): Promise<PersistentStorageStatus> {
  if (
    typeof window === 'undefined' ||
    window.isSecureContext !== true ||
    typeof navigator === 'undefined' ||
    !navigator.storage
  ) {
    return 'unavailable'
  }
  try {
    if (await navigator.storage.persisted?.()) return 'persisted'
    if (await navigator.storage.persist?.()) return 'persisted'
    return 'best-effort'
  } catch {
    return 'best-effort'
  }
}

function cachedSessionEventsFromHotWindow(hotWindow: CachedEventHotWindow): CachedSessionEvents {
  const bounded = boundEventWindow(hotWindow.events, 'latest', cachedEventWindowPolicy)
  const oldestSeq = firstSeq(bounded.events)
  return {
    events: bounded.events,
    lastSeq: Math.max(hotWindow.lastSeq, lastSeq(bounded.events)),
    oldestSeq,
    hasOlderEvents: hotWindow.hasOlderEvents || bounded.trimmedStart || oldestSeq > 1,
  }
}

function isCachedEventHotWindow(
  hotWindow: CachedEventHotWindow | null,
  sessionID: string,
): hotWindow is CachedEventHotWindow {
  return (
    hotWindow !== null &&
    hotWindow.sessionID === sessionID &&
    Array.isArray(hotWindow.events) &&
    Number.isFinite(hotWindow.lastSeq) &&
    typeof hotWindow.hasOlderEvents === 'boolean'
  )
}

async function putCachedEventHotWindow(
  db: IDBDatabase,
  sessionID: string,
  events: AgentEvent[],
  options: CachedSessionEventPageOptions,
) {
  const durableEvents = events
    .filter((event) => !isTransientEvent(event))
    .map((event) => cachedEventRecord(sessionID, event).event)

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(eventHotWindowStore, 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB recent window write failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB recent window write aborted'))
    try {
      const store = transaction.objectStore(eventHotWindowStore)
      const request = store.get(sessionID)
      request.onerror = () => transaction.abort()
      request.onsuccess = () => {
        const stored = (request.result as CachedEventHotWindow | undefined) ?? null
        const previous = isCachedEventHotWindow(stored, sessionID) ? stored : null
        const previousEvents = previous?.events ?? []
        const bounded = boundEventWindow([...previousEvents, ...durableEvents], 'latest', cachedEventWindowPolicy)
        const oldestSeq = firstSeq(bounded.events)
        const cursorSeq = Math.max(options.serverLastSeq ?? 0, options.coverageLastSeq ?? 0, lastSeq(events))
        if (previous && previous.lastSeq > cursorSeq) return
        const next: CachedEventHotWindow = {
          sessionID,
          events: bounded.events,
          lastSeq: Math.max(previous?.lastSeq ?? 0, cursorSeq, lastSeq(bounded.events)),
          oldestSeq,
          hasOlderEvents:
            oldestSeq > 0
              ? bounded.trimmedStart || oldestSeq > 1
              : previous?.hasOlderEvents === true || options.hasOlderEvents === true,
          usedAt: Date.now(),
          bytes: serializedEventsBytes(bounded.events),
        }
        store.put(next)
      }
    } catch (error) {
      transaction.abort()
      reject(error)
    }
  })
  await enforceHotWindowStorageBudget(db, sessionID)
}

async function touchCachedEventMeta(db: IDBDatabase, sessionID: string) {
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(eventMetaStore, 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => resolve()
    transaction.onabort = () => resolve()
    const store = transaction.objectStore(eventMetaStore)
    const request = store.get(sessionID)
    request.onerror = () => resolve()
    request.onsuccess = () => {
      const meta = request.result as CachedEventMeta | undefined
      if (meta) store.put({ ...meta, usedAt: Date.now() })
    }
  })
}

async function writeCachedSessionEventPageNow(
  db: IDBDatabase,
  sessionID: string,
  events: AgentEvent[],
  options: CachedSessionEventPageOptions,
) {
  const durableEvents = new Map<number, AgentEvent>()
  for (const event of events) {
    if (!isTransientEvent(event)) durableEvents.set(event.seq, event)
  }
  const records = [...durableEvents.values()].map((event) => cachedEventRecord(sessionID, event))
  const existing = await getRecords<CachedEventRecord>(
    db,
    eventRecordsStore,
    records.map((record) => record.key),
  )
  const replacedBytes = existing.reduce((total, record) => total + (record?.bytes ?? 0), 0)
  const addedBytes = records.reduce((total, record) => total + record.bytes, 0)
  const previous = await getRecord<CachedEventMeta>(db, eventMetaStore, sessionID)
  const coverageFirstSeq = positiveSeq(options.coverageFirstSeq ?? firstSeq(events))
  const coverageLastSeq = positiveSeq(options.coverageLastSeq ?? lastSeq(events))
  const coverage =
    coverageFirstSeq > 0 && coverageLastSeq >= coverageFirstSeq
      ? mergeCoverage(previous?.coverage ?? [], { firstSeq: coverageFirstSeq, lastSeq: coverageLastSeq })
      : previous?.coverage ?? []
  const next: CachedEventMeta = {
    sessionID,
    lastSeq: Math.max(previous?.lastSeq ?? 0, options.serverLastSeq ?? 0, lastSeq(events)),
    hasOlderEvents:
      coverage.length > 0
        ? coverage[0].firstSeq > 1
        : previous?.hasOlderEvents === true || options.hasOlderEvents === true,
    usedAt: Date.now(),
    bytes: Math.max(0, (previous?.bytes ?? 0) - replacedBytes + addedBytes),
    coverage,
  }

  await reserveEventStorageBudget(db, sessionID, Math.max(0, next.bytes - (previous?.bytes ?? 0)))
  await putEventPage(db, records, next)
}

function cachedEventRecord(sessionID: string, event: AgentEvent): CachedEventRecord {
  const bytes = serializedEventBytes(event)
  const cachedEvent =
    bytes <= persistentCachedSingleEventBytesLimit
      ? event
      : { ...event, payload: { _gorchestra_window_truncated: true } }
  return {
    key: eventRecordKey(sessionID, event.seq),
    sessionID,
    seq: event.seq,
    event: cachedEvent,
    bytes: serializedEventBytes(cachedEvent),
  }
}

async function migrateLegacySessionEvents(db: IDBDatabase, sessionID: string): Promise<CachedEventMeta | null> {
  const keys = [legacySessionEventsCacheKey(sessionID, false), sessionID]
  let legacy: LegacyCachedSessionEventsRecord | null = null
  let legacyKey = ''
  for (const key of keys) {
    legacy = await getRecord<LegacyCachedSessionEventsRecord>(db, legacyEventsStore, key)
    if (legacy) {
      legacyKey = key
      break
    }
  }
  if (!legacy) return null

  await writeCachedSessionEventPageNow(db, sessionID, legacy.events ?? [], {
    coverageFirstSeq: legacy.oldestSeq || firstSeq(legacy.events),
    coverageLastSeq: legacy.lastSeq || lastSeq(legacy.events),
    serverLastSeq: legacy.lastSeq,
    hasOlderEvents: legacy.hasOlderEvents,
  })
  await deleteRecord(db, legacyEventsStore, legacyKey)
  return getRecord<CachedEventMeta>(db, eventMetaStore, sessionID)
}

async function getLatestSessionEventRecords(
  db: IDBDatabase,
  sessionID: string,
  beforeSeq: number,
  minimumSeq: number,
  maxTurns: number,
  maxEvents: number,
  maxBytes: number,
): Promise<CachedEventRecord[]> {
  if (typeof IDBKeyRange === 'undefined') {
    const records = (await getSessionEventRecords(db, sessionID)).filter(
      (record) => record.seq >= minimumSeq && record.seq < beforeSeq,
    )
    return selectLatestEventRecords(records, maxTurns, maxEvents, maxBytes)
  }

  return new Promise((resolve) => {
    const lower = eventRecordKey(sessionID, Math.max(0, minimumSeq))
    const upper = eventRecordKey(sessionID, Math.max(0, beforeSeq - 1))
    const range = IDBKeyRange.bound(lower, upper)
    const transaction = db.transaction(eventRecordsStore, 'readonly')
    const request = transaction.objectStore(eventRecordsStore).openCursor(range, 'prev')
    const records: CachedEventRecord[] = []
    let turns = 0
    let bytes = 0
    request.onerror = () => resolve([])
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve(records.reverse())
        return
      }
      const record = cursor.value as CachedEventRecord
      const selected = records.length > 0
      if (
        selected &&
        (turns >= maxTurns || records.length >= maxEvents || bytes + record.bytes > maxBytes)
      ) {
        resolve(records.reverse())
        return
      }
      records.push(record)
      bytes += record.bytes
      if (record.event.type === 'user.message.completed') turns += 1
      cursor.continue()
    }
  })
}

function selectLatestEventRecords(
  records: CachedEventRecord[],
  maxTurns: number,
  maxEvents: number,
  maxBytes: number,
) {
  const selected: CachedEventRecord[] = []
  let turns = 0
  let bytes = 0
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (
      selected.length > 0 &&
      (turns >= maxTurns || selected.length >= maxEvents || bytes + record.bytes > maxBytes)
    ) {
      break
    }
    selected.push(record)
    bytes += record.bytes
    if (record.event.type === 'user.message.completed') turns += 1
  }
  return selected.reverse()
}

async function enforceEventStorageBudgets(db: IDBDatabase, protectedSessionID: string) {
  await pruneSessionEventRecords(db, protectedSessionID)
  const metadata = await getAllRecords<CachedEventMeta>(db, eventMetaStore)
  let totalBytes = metadata.reduce((total, meta) => total + meta.bytes, 0)
  if (totalBytes <= persistentGlobalEventBytesLimit) return

  const victims = metadata
    .filter((meta) => meta.sessionID !== protectedSessionID)
    .sort((left, right) => left.usedAt - right.usedAt)
  for (const victim of victims) {
    await deleteSessionEventRecords(db, victim.sessionID)
    await deleteRecord(db, eventMetaStore, victim.sessionID)
    totalBytes -= victim.bytes
    if (totalBytes <= persistentGlobalEventBytesLimit) break
  }
}

async function reserveEventStorageBudget(db: IDBDatabase, protectedSessionID: string, addedBytes: number) {
  if (addedBytes <= 0) return
  const metadata = await getAllRecords<CachedEventMeta>(db, eventMetaStore)
  let projectedBytes = metadata.reduce((total, meta) => total + meta.bytes, 0) + addedBytes
  if (projectedBytes <= persistentGlobalEventBytesLimit) return

  const victims = metadata
    .filter((meta) => meta.sessionID !== protectedSessionID)
    .sort((left, right) => left.usedAt - right.usedAt)
  for (const victim of victims) {
    await deleteSessionEventRecords(db, victim.sessionID)
    await deleteRecord(db, eventMetaStore, victim.sessionID)
    projectedBytes -= victim.bytes
    if (projectedBytes <= persistentGlobalEventBytesLimit) break
  }
}

async function freeEventStorageForRetry(db: IDBDatabase, protectedSessionID: string) {
  const metadata = await getAllRecords<CachedEventMeta>(db, eventMetaStore)
  const victims = metadata
    .filter((meta) => meta.sessionID !== protectedSessionID)
    .sort((left, right) => left.usedAt - right.usedAt)
  for (const victim of victims) {
    await deleteSessionEventRecords(db, victim.sessionID)
    await deleteRecord(db, eventMetaStore, victim.sessionID)
  }
}

async function enforceHotWindowStorageBudget(db: IDBDatabase, protectedSessionID: string) {
  const [windows, metadata] = await Promise.all([
    getAllRecords<CachedEventHotWindow>(db, eventHotWindowStore),
    getAllRecords<CachedEventMeta>(db, eventMetaStore),
  ])
  const usedAtBySession = new Map(metadata.map((meta) => [meta.sessionID, meta.usedAt]))
  let retainedCount = windows.length
  let retainedBytes = windows.reduce((total, window) => total + window.bytes, 0)
  const victims = windows
    .filter((window) => window.sessionID !== protectedSessionID)
    .sort(
      (left, right) =>
        (usedAtBySession.get(left.sessionID) ?? left.usedAt) -
        (usedAtBySession.get(right.sessionID) ?? right.usedAt),
    )
  for (const victim of victims) {
    if (retainedCount <= persistentHotWindowLimit && retainedBytes <= persistentHotWindowBytesLimit) break
    await deleteRecord(db, eventHotWindowStore, victim.sessionID)
    retainedCount -= 1
    retainedBytes -= victim.bytes
  }
}

async function freeHotWindowStorageForRetry(db: IDBDatabase, protectedSessionID: string) {
  const windows = await getAllRecords<CachedEventHotWindow>(db, eventHotWindowStore)
  const victims = windows
    .filter((window) => window.sessionID !== protectedSessionID)
    .sort((left, right) => left.usedAt - right.usedAt)
  await deleteRecords(
    db,
    eventHotWindowStore,
    victims.map((window) => window.sessionID),
  )
}

async function pruneSessionEventRecords(db: IDBDatabase, sessionID: string) {
  const meta = await getRecord<CachedEventMeta>(db, eventMetaStore, sessionID)
  if (!meta || meta.bytes <= persistentCachedEventBytesLimit) return
  const records = await getSessionEventRecords(db, sessionID)
  let retainedBytes = records.reduce((total, record) => total + record.bytes, 0)
  const remove: CachedEventRecord[] = []
  for (const record of records) {
    if (retainedBytes <= persistentCachedEventBytesLimit || records.length - remove.length <= 1) break
    remove.push(record)
    retainedBytes -= record.bytes
  }
  await deleteRecords(
    db,
    eventRecordsStore,
    remove.map((record) => record.key),
  )
  const firstRetainedSeq = records[remove.length]?.seq ?? 0
  const coverage = meta.coverage
    .filter((range) => range.lastSeq >= firstRetainedSeq)
    .map((range) => ({ ...range, firstSeq: Math.max(range.firstSeq, firstRetainedSeq) }))
  await putRecord(db, eventMetaStore, {
    ...meta,
    bytes: retainedBytes,
    hasOlderEvents: true,
    coverage,
  })
}

async function deleteSessionEventRecords(db: IDBDatabase, sessionID: string) {
  const records = await getSessionEventRecords(db, sessionID)
  await deleteRecords(
    db,
    eventRecordsStore,
    records.map((record) => record.key),
  )
}

function mergeCoverage(coverage: CachedEventCoverage[], added: CachedEventCoverage) {
  const merged: CachedEventCoverage[] = []
  for (const current of [...coverage, added].sort((left, right) => left.firstSeq - right.firstSeq)) {
    const previous = merged[merged.length - 1]
    if (!previous || current.firstSeq > previous.lastSeq + 1) {
      merged.push({ ...current })
      continue
    }
    previous.lastSeq = Math.max(previous.lastSeq, current.lastSeq)
  }
  return merged
}

function enqueueSessionWrite(sessionID: string, operation: () => Promise<void>) {
  const current = eventWriteQueue.catch(() => undefined).then(operation)
  eventWriteQueue = current
  eventWriteQueues.set(sessionID, current)
  return current.finally(() => {
    if (eventWriteQueues.get(sessionID) === current) eventWriteQueues.delete(sessionID)
  })
}

async function waitForSessionWrites(sessionID: string) {
  await eventWriteQueues.get(sessionID)?.catch(() => undefined)
}

function legacySessionEventsCacheKey(sessionID: string, includeDebugEvents: boolean) {
  return `${sessionID}:${includeDebugEvents ? 'debug' : 'normal'}`
}

function eventRecordKey(sessionID: string, seq: number) {
  return `${sessionID}:${String(seq).padStart(20, '0')}`
}

function readSyncSessionCache(): SyncCachedSessions {
  if (typeof window === 'undefined') return emptySyncSessionCache()
  try {
    const raw = window.localStorage.getItem(syncSessionCacheStorageKey)
    if (!raw) return emptySyncSessionCache()
    const parsed = JSON.parse(raw) as Partial<SyncCachedSessions>
    if (!Array.isArray(parsed.sessions)) return emptySyncSessionCache()
    const sessions = parsed.sessions
      .map((record): SyncCachedSessionRecord | null => {
        if (!record || typeof record !== 'object') return null
        const syncRecord = record as Partial<SyncCachedSessionRecord>
        const session = syncRecord.session
        if (!isSession(session)) return null
        const id = typeof syncRecord.id === 'string' ? syncRecord.id : session.id
        if (id !== session.id) return null
        const slug = typeof syncRecord.slug === 'string' ? syncRecord.slug : sessionTitleSlug(session.title)
        const usedAt = Number(syncRecord.usedAt)
        return { id, session, slug, usedAt: Number.isFinite(usedAt) && usedAt > 0 ? usedAt : 0 }
      })
      .filter((record): record is SyncCachedSessionRecord => Boolean(record))
    const evicted = evictSyncSessionRecords(sessions)
    return { sessions: evicted, aliases: aliasesForSessions(evicted) }
  } catch {
    return emptySyncSessionCache()
  }
}

function writeSyncSessionCache(cache: SyncCachedSessions) {
  if (typeof window === 'undefined') return
  try {
    const sessions = evictSyncSessionRecords(cache.sessions)
    window.localStorage.setItem(
      syncSessionCacheStorageKey,
      JSON.stringify({ sessions, aliases: aliasesForSessions(sessions) }),
    )
  } catch {
    // IndexedDB remains available when localStorage is full or disabled.
  }
}

function emptySyncSessionCache(): SyncCachedSessions {
  return { sessions: [], aliases: {} }
}

function upsertSyncSession(cache: SyncCachedSessions, session: Session, usedAt = Date.now()): SyncCachedSessions {
  const slug = sessionTitleSlug(session.title)
  const sessions = evictSyncSessionRecords([
    { id: session.id, session, slug, usedAt },
    ...cache.sessions.filter((record) => record.id !== session.id),
  ])
  return { sessions, aliases: aliasesForSessions(sessions) }
}

function evictSyncSessionRecords(records: SyncCachedSessionRecord[]) {
  return [...records].sort((left, right) => right.usedAt - left.usedAt).slice(0, cachedSessionLimit)
}

function aliasesForSessions(records: SyncCachedSessionRecord[]) {
  const aliases: Record<string, string> = {}
  for (const record of [...records].sort((left, right) => left.usedAt - right.usedAt)) {
    aliases[record.slug] = record.id
  }
  return aliases
}

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false
  const session = value as Partial<Session>
  return (
    typeof session.id === 'string' &&
    typeof session.title === 'string' &&
    typeof session.agent_type === 'string' &&
    typeof session.status === 'string' &&
    typeof session.workspace_path === 'string' &&
    typeof session.event_count === 'number' &&
    typeof session.tool_count === 'number' &&
    typeof session.created_at === 'string' &&
    typeof session.updated_at === 'string'
  )
}

async function openCacheDB(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null
  dbPromise ??= new Promise((resolve) => {
    const request = indexedDB.open(dbName, dbVersion)
    let unavailable = false
    request.onerror = () => {
      unavailable = true
      console.warn('Unable to open the session cache.', request.error)
      resolve(null)
    }
    request.onblocked = () => {
      unavailable = true
      console.warn('Session cache upgrade is blocked by another open Gorchestra tab.')
      resolve(null)
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(sessionsStore)) {
        db.createObjectStore(sessionsStore, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(legacyEventsStore)) {
        db.createObjectStore(legacyEventsStore, { keyPath: 'sessionID' })
      }
      let recordStore: IDBObjectStore
      if (!db.objectStoreNames.contains(eventRecordsStore)) {
        recordStore = db.createObjectStore(eventRecordsStore, { keyPath: 'key' })
      } else {
        recordStore = request.transaction!.objectStore(eventRecordsStore)
      }
      if (!recordStore.indexNames.contains(eventRecordsSessionIndex)) {
        recordStore.createIndex(eventRecordsSessionIndex, 'sessionID', { unique: false })
      }
      if (!db.objectStoreNames.contains(eventMetaStore)) {
        db.createObjectStore(eventMetaStore, { keyPath: 'sessionID' })
      }
      if (!db.objectStoreNames.contains(eventHotWindowStore)) {
        db.createObjectStore(eventHotWindowStore, { keyPath: 'sessionID' })
      }
    }
    request.onsuccess = () => {
      const db = request.result
      if (unavailable) {
        db.close()
        dbPromise = null
        return
      }
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
  })
  return dbPromise
}

function getRecord<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | null> {
  return new Promise((resolve) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key)
    request.onerror = () => resolve(null)
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null)
  })
}

function getRecords<T>(db: IDBDatabase, storeName: string, keys: IDBValidKey[]): Promise<Array<T | null>> {
  if (keys.length === 0) return Promise.resolve([])
  return new Promise((resolve) => {
    const results: Array<T | null> = Array.from({ length: keys.length }, () => null)
    const transaction = db.transaction(storeName, 'readonly')
    keys.forEach((key, index) => {
      const request = transaction.objectStore(storeName).get(key)
      request.onsuccess = () => {
        results[index] = (request.result as T | undefined) ?? null
      }
    })
    transaction.oncomplete = () => resolve(results)
    transaction.onerror = () => resolve(results)
    transaction.onabort = () => resolve(results)
  })
}

function getAllRecords<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll()
    request.onerror = () => resolve([])
    request.onsuccess = () => resolve((request.result as T[] | undefined) ?? [])
  })
}

function getSessionEventRecords(db: IDBDatabase, sessionID: string): Promise<CachedEventRecord[]> {
  return new Promise((resolve) => {
    const transaction = db.transaction(eventRecordsStore, 'readonly')
    const request = transaction.objectStore(eventRecordsStore).index(eventRecordsSessionIndex).getAll(sessionID)
    request.onerror = () => resolve([])
    request.onsuccess = () => {
      const records = (request.result as CachedEventRecord[] | undefined) ?? []
      resolve(records.sort((left, right) => left.seq - right.seq))
    }
  })
}

function putRecord<T>(db: IDBDatabase, storeName: string, value: T): Promise<void> {
  return putRecords(db, storeName, [value])
}

function putEventPage(db: IDBDatabase, records: CachedEventRecord[], meta: CachedEventMeta): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([eventRecordsStore, eventMetaStore], 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB event cache write failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB event cache write aborted'))
    try {
      const eventStore = transaction.objectStore(eventRecordsStore)
      records.forEach((record) => eventStore.put(record))
      transaction.objectStore(eventMetaStore).put(meta)
    } catch (error) {
      transaction.abort()
      reject(error)
    }
  })
}

function putRecords<T>(db: IDBDatabase, storeName: string, values: T[]): Promise<void> {
  if (values.length === 0) return Promise.resolve()
  return new Promise((resolve) => {
    const transaction = db.transaction(storeName, 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => resolve()
    transaction.onabort = () => resolve()
    const store = transaction.objectStore(storeName)
    values.forEach((value) => store.put(value))
  })
}

function deleteRecord(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<void> {
  return deleteRecords(db, storeName, [key])
}

function deleteRecords(db: IDBDatabase, storeName: string, keys: IDBValidKey[]): Promise<void> {
  if (keys.length === 0) return Promise.resolve()
  return new Promise((resolve) => {
    const transaction = db.transaction(storeName, 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => resolve()
    transaction.onabort = () => resolve()
    const store = transaction.objectStore(storeName)
    keys.forEach((key) => store.delete(key))
  })
}

async function evictOldRecords(db: IDBDatabase, storeName: string, limit: number) {
  const records = await getAllRecords<{ id?: string; sessionID?: string; usedAt: number }>(db, storeName)
  if (records.length <= limit) return
  const expired = records.sort((left, right) => left.usedAt - right.usedAt).slice(0, records.length - limit)
  await deleteRecords(
    db,
    storeName,
    expired.flatMap((record) => {
      const key = record.id ?? record.sessionID
      return key ? [key] : []
    }),
  )
}

function firstSeq(events: AgentEvent[]) {
  return events.reduce((min, event) => (min === 0 ? event.seq : Math.min(min, event.seq)), 0)
}

function lastSeq(events: AgentEvent[]) {
  return events.reduce((max, event) => Math.max(max, event.seq), 0)
}

function positiveSeq(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function serializedEventBytes(event: AgentEvent) {
  try {
    return new TextEncoder().encode(JSON.stringify(event)).byteLength
  } catch {
    return persistentCachedSingleEventBytesLimit + 1
  }
}

function serializedEventsBytes(events: AgentEvent[]) {
  return events.reduce((total, event) => total + serializedEventBytes(event), 0)
}
