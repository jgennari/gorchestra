import type { AgentEvent, Session } from '@/lib/api'

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

const dbName = 'gorchestra-session-cache'
const dbVersion = 1
const sessionsStore = 'sessions'
const eventsStore = 'events'
const cachedSessionLimit = 8
export const persistentCachedEventLimit = 1000

let dbPromise: Promise<IDBDatabase | null> | null = null

export async function readCachedSession(sessionID: string): Promise<Session | null> {
  const db = await openCacheDB()
  if (!db) return null

  const record = await getRecord<CachedSessionRecord>(db, sessionsStore, sessionID)
  if (!record) return null

  await putRecord(db, sessionsStore, { ...record, usedAt: Date.now() })
  return record.session
}

export async function writeCachedSession(session: Session): Promise<void> {
  const db = await openCacheDB()
  if (!db) return

  await putRecord(db, sessionsStore, { id: session.id, session, usedAt: Date.now() })
  await evictOldRecords(db, sessionsStore, cachedSessionLimit)
}

export async function writeCachedSessions(sessions: Session[]): Promise<void> {
  await Promise.all(sessions.map((session) => writeCachedSession(session)))
}

export async function deleteCachedSession(sessionID: string): Promise<void> {
  const db = await openCacheDB()
  if (!db) return

  await Promise.all([deleteRecord(db, sessionsStore, sessionID), deleteRecord(db, eventsStore, sessionID)])
}

export async function readCachedSessionEvents(sessionID: string): Promise<CachedSessionEvents | null> {
  const db = await openCacheDB()
  if (!db) return null

  const record = await getRecord<CachedSessionEventsRecord>(db, eventsStore, sessionID)
  if (!record) return null

  const next = { ...record, usedAt: Date.now() }
  await putRecord(db, eventsStore, next)
  return {
    events: record.events,
    lastSeq: record.lastSeq,
    oldestSeq: record.oldestSeq,
    hasOlderEvents: record.hasOlderEvents,
  }
}

export async function writeCachedSessionEvents(
  sessionID: string,
  events: AgentEvent[],
  hasOlderEvents: boolean,
): Promise<void> {
  const db = await openCacheDB()
  if (!db) return

  const trimmedEvents = trimPersistentEvents(events)
  const trimmedOlderEvents = trimmedEvents.length < events.length
  await putRecord(db, eventsStore, {
    sessionID,
    events: trimmedEvents,
    lastSeq: lastSeq(trimmedEvents),
    oldestSeq: firstSeq(trimmedEvents),
    hasOlderEvents: hasOlderEvents || trimmedOlderEvents,
    usedAt: Date.now(),
  })
  await evictOldRecords(db, eventsStore, cachedSessionLimit)
}

export function clearSessionCacheForTest() {
  dbPromise = null
}

async function openCacheDB(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return null
  }
  dbPromise ??= new Promise((resolve) => {
    const request = indexedDB.open(dbName, dbVersion)
    request.onerror = () => resolve(null)
    request.onupgradeneeded = () => {
      const db = request.result
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
  if (events.length <= persistentCachedEventLimit) {
    return events
  }
  let start = events.length - persistentCachedEventLimit
  for (let index = start; index < events.length; index += 1) {
    if (safeLeadingWindowEvent(events[index])) {
      start = index
      break
    }
  }
  return events.slice(start)
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
