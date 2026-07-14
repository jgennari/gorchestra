import type { AgentEvent, Session } from '@/lib/api'
import { sessionTitleSlug } from '@/lib/routes'

export type CachedSessionEvents = {
  events: AgentEvent[]
  lastSeq: number
  oldestSeq: number
  hasOlderEvents: boolean
}

type CachedSessionRecord = {
  id: string
  session: Session
  usedAt: number
}

type CachedSessionEventsRecord = CachedSessionEvents & {
  sessionID: string
  usedAt: number
}

type SyncCachedSessionRecord = CachedSessionRecord & {
  slug: string
}

type SyncCachedSessions = {
  sessions: SyncCachedSessionRecord[]
  aliases: Record<string, string>
}

const dbName = 'gorchestra-session-cache'
const dbVersion = 3
const sessionsStore = 'sessions'
const eventsStore = 'events'
const cachedSessionLimit = 8
const syncSessionCacheStorageKey = 'gorchestra.session-snapshots.v1'
export const persistentCachedEventLimit = 500
export const persistentCachedEventBytesLimit = 512 * 1024
export const persistentCachedSingleEventBytesLimit = 96 * 1024

let dbPromise: Promise<IDBDatabase | null> | null = null

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
  const cache = readSyncSessionCache()
  writeSyncSessionCache({
    sessions: cache.sessions.filter((record) => record.id !== sessionID),
    aliases: aliasesForSessions(cache.sessions.filter((record) => record.id !== sessionID)),
  })
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

  await Promise.all(
    sessions.map((session) => putRecord(db, sessionsStore, { id: session.id, session, usedAt: Date.now() })),
  )
  await evictOldRecords(db, sessionsStore, cachedSessionLimit)
}

export async function deleteCachedSession(sessionID: string): Promise<void> {
  deleteCachedSessionSnapshot(sessionID)
  const db = await openCacheDB()
  if (!db) return

  await Promise.all([
    deleteRecord(db, sessionsStore, sessionID),
    deleteRecord(db, eventsStore, sessionID),
    deleteRecord(db, eventsStore, sessionEventsCacheKey(sessionID, false)),
    deleteRecord(db, eventsStore, sessionEventsCacheKey(sessionID, true)),
  ])
}

export async function readCachedSessionEvents(
  sessionID: string,
  includeDebugEvents = false,
): Promise<CachedSessionEvents | null> {
  if (includeDebugEvents) return null
  const db = await openCacheDB()
  if (!db) return null

  const cacheKey = sessionEventsCacheKey(sessionID, includeDebugEvents)
  const record = await getRecord<CachedSessionEventsRecord>(db, eventsStore, cacheKey)
  if (!record) return null

  const trimmedEvents = trimPersistentEvents(record.events)
  if (trimmedEvents.length === 0) {
    await deleteRecord(db, eventsStore, cacheKey)
    return null
  }
  const durableRecordEventCount = record.events.filter((event) => !isTransientEvent(event)).length
  const trimmedOlderEvents = trimmedEvents.length < durableRecordEventCount
  const cursorSeq = Math.max(Number(record.lastSeq) || 0, lastSeq(trimmedEvents))
  const next = {
    ...record,
    events: trimmedEvents,
    lastSeq: cursorSeq,
    oldestSeq: firstSeq(trimmedEvents),
    hasOlderEvents: record.hasOlderEvents || trimmedOlderEvents,
    usedAt: Date.now(),
  }
  await putRecord(db, eventsStore, next)
  return {
    events: next.events,
    lastSeq: next.lastSeq,
    oldestSeq: next.oldestSeq,
    hasOlderEvents: next.hasOlderEvents,
  }
}

export async function writeCachedSessionEvents(
  sessionID: string,
  events: AgentEvent[],
  hasOlderEvents: boolean,
  includeDebugEvents = false,
  cursorSeq = lastSeq(events),
): Promise<void> {
  if (includeDebugEvents) return
  const db = await openCacheDB()
  if (!db) return

  const cacheKey = sessionEventsCacheKey(sessionID, includeDebugEvents)
  const trimmedEvents = trimPersistentEvents(events)
  if (trimmedEvents.length === 0) {
    await deleteRecord(db, eventsStore, cacheKey)
    return
  }
  const durableEventCount = events.filter((event) => !isTransientEvent(event)).length
  const trimmedOlderEvents = trimmedEvents.length < durableEventCount
  await putRecord(db, eventsStore, {
    sessionID: cacheKey,
    events: trimmedEvents,
    lastSeq: Math.max(cursorSeq, lastSeq(trimmedEvents)),
    oldestSeq: firstSeq(trimmedEvents),
    hasOlderEvents: hasOlderEvents || trimmedOlderEvents,
    usedAt: Date.now(),
  })
  await evictOldRecords(db, eventsStore, cachedSessionLimit)
}

function sessionEventsCacheKey(sessionID: string, includeDebugEvents: boolean) {
  return `${sessionID}:${includeDebugEvents ? 'debug' : 'normal'}`
}

export function clearSessionCacheForTest() {
  dbPromise = null
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(syncSessionCacheStorageKey)
  }
}

function readSyncSessionCache(): SyncCachedSessions {
  if (typeof window === 'undefined') {
    return emptySyncSessionCache()
  }
  try {
    const raw = window.localStorage.getItem(syncSessionCacheStorageKey)
    if (!raw) {
      return emptySyncSessionCache()
    }
    const parsed = JSON.parse(raw) as Partial<SyncCachedSessions>
    if (!Array.isArray(parsed.sessions)) {
      return emptySyncSessionCache()
    }
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
        return {
          id,
          session,
          slug,
          usedAt: Number.isFinite(usedAt) && usedAt > 0 ? usedAt : 0,
        }
      })
      .filter((record): record is SyncCachedSessionRecord => Boolean(record))

    const evicted = evictSyncSessionRecords(sessions)
    return {
      sessions: evicted,
      aliases: aliasesForSessions(evicted),
    }
  } catch {
    return emptySyncSessionCache()
  }
}

function writeSyncSessionCache(cache: SyncCachedSessions) {
  if (typeof window === 'undefined') {
    return
  }
  try {
    const sessions = evictSyncSessionRecords(cache.sessions)
    window.localStorage.setItem(
      syncSessionCacheStorageKey,
      JSON.stringify({
        sessions,
        aliases: aliasesForSessions(sessions),
      }),
    )
  } catch {
    // The persistent IndexedDB cache remains available when localStorage fails.
  }
}

function emptySyncSessionCache(): SyncCachedSessions {
  return { sessions: [], aliases: {} }
}

function upsertSyncSession(cache: SyncCachedSessions, session: Session, usedAt = Date.now()): SyncCachedSessions {
  const slug = sessionTitleSlug(session.title)
  const withoutSession = cache.sessions.filter((record) => record.id !== session.id)
  const sessions = evictSyncSessionRecords([
    {
      id: session.id,
      session,
      slug,
      usedAt,
    },
    ...withoutSession,
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
  if (typeof indexedDB === 'undefined') {
    return null
  }
  dbPromise ??= new Promise((resolve) => {
    const request = indexedDB.open(dbName, dbVersion)
    request.onerror = () => resolve(null)
    request.onupgradeneeded = (event) => {
      const db = request.result
      if (event.oldVersion > 0 && event.oldVersion < 3 && db.objectStoreNames.contains(eventsStore)) {
        db.deleteObjectStore(eventsStore)
      }
      if (!db.objectStoreNames.contains(sessionsStore)) {
        db.createObjectStore(sessionsStore, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(eventsStore)) {
        db.createObjectStore(eventsStore, { keyPath: 'sessionID' })
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
  return dbPromise
}

function getRecord<T>(db: IDBDatabase, storeName: string, key: string): Promise<T | null> {
  return new Promise((resolve) => {
    const transaction = db.transaction(storeName, 'readonly')
    const request = transaction.objectStore(storeName).get(key)
    request.onerror = () => resolve(null)
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null)
  })
}

function getAllRecords<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve) => {
    const transaction = db.transaction(storeName, 'readonly')
    const request = transaction.objectStore(storeName).getAll()
    request.onerror = () => resolve([])
    request.onsuccess = () => resolve((request.result as T[] | undefined) ?? [])
  })
}

function putRecord<T>(db: IDBDatabase, storeName: string, value: T): Promise<void> {
  return new Promise((resolve) => {
    const transaction = db.transaction(storeName, 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => resolve()
    transaction.objectStore(storeName).put(value)
  })
}

function deleteRecord(db: IDBDatabase, storeName: string, key: string): Promise<void> {
  return new Promise((resolve) => {
    const transaction = db.transaction(storeName, 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => resolve()
    transaction.objectStore(storeName).delete(key)
  })
}

async function evictOldRecords(db: IDBDatabase, storeName: string, limit: number) {
  const records = await getAllRecords<{ id?: string; sessionID?: string; usedAt: number }>(db, storeName)
  if (records.length <= limit) return

  const expiredRecords = records
    .sort((left, right) => left.usedAt - right.usedAt)
    .slice(0, records.length - limit)
  await Promise.all(
    expiredRecords.map((record) => {
      const key = record.id ?? record.sessionID
      return key ? deleteRecord(db, storeName, key) : Promise.resolve()
    }),
  )
}

function firstSeq(events: AgentEvent[]) {
  return events.reduce((min, event) => (min === 0 ? event.seq : Math.min(min, event.seq)), 0)
}

function lastSeq(events: AgentEvent[]) {
  return events.reduce((max, event) => Math.max(max, event.seq), 0)
}

function trimPersistentEvents(events: AgentEvent[]) {
  const durableEvents = events.filter((event) => !isTransientEvent(event))
  const countTrimmedEvents =
    durableEvents.length <= persistentCachedEventLimit
      ? durableEvents
      : durableEvents.slice(durableEvents.length - persistentCachedEventLimit)
  const byteTrimmedEvents: AgentEvent[] = []
  let totalBytes = 2

  for (let index = countTrimmedEvents.length - 1; index >= 0; index -= 1) {
    const event = countTrimmedEvents[index]
    const eventBytes = serializedEventBytes(event)
    if (eventBytes > persistentCachedSingleEventBytesLimit) {
      continue
    }
    const nextTotalBytes = totalBytes + eventBytes + (byteTrimmedEvents.length > 0 ? 1 : 0)
    if (nextTotalBytes > persistentCachedEventBytesLimit) {
      break
    }
    byteTrimmedEvents.unshift(event)
    totalBytes = nextTotalBytes
  }

  let start = 0
  for (let index = 0; index < byteTrimmedEvents.length; index += 1) {
    if (safeLeadingWindowEvent(byteTrimmedEvents[index])) {
      start = index
      break
    }
    if (index === byteTrimmedEvents.length - 1) {
      return []
    }
  }
  return byteTrimmedEvents.slice(start)
}

function serializedEventBytes(event: AgentEvent) {
  try {
    return JSON.stringify(event).length
  } catch {
    return persistentCachedSingleEventBytesLimit + 1
  }
}

function safeLeadingWindowEvent(event: AgentEvent | undefined) {
  if (!event) {
    return true
  }

  switch (event.type) {
    case 'agent.message.delta':
    case 'agent.plan.delta':
    case 'agent.thinking.delta':
    case 'agent.log.delta':
    case 'tool.call.delta':
    case 'file.change.delta':
    case 'tool.call.completed':
    case 'file.change.completed':
    case 'agent.thinking.completed':
      return false
    default:
      return true
  }
}

function isTransientEvent(event: AgentEvent) {
  return event.transient === true || event.type.endsWith('.delta')
}
