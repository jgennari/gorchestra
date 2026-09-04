export type NotificationAttentionRecord = {
  sessionID: string
  seq: number
  createdAt: number
}

const dbName = 'gorchestra-notification-attention'
const dbVersion = 1
const attentionStore = 'sessions'

let dbPromise: Promise<IDBDatabase | null> | null = null

export async function readNotificationAttentionSeqs(): Promise<Record<string, number>> {
  const db = await openAttentionDB()
  if (!db) return {}

  const records = await getAllRecords<NotificationAttentionRecord>(db, attentionStore)
  const seqs: Record<string, number> = {}
  for (const record of records) {
    if (record.sessionID && Number.isFinite(record.seq) && record.seq > 0) {
      seqs[record.sessionID] = Math.max(seqs[record.sessionID] ?? 0, record.seq)
    }
  }
  return seqs
}

export async function writeNotificationAttention(sessionID: string, seq: number): Promise<void> {
  const cleanSessionID = sessionID.trim()
  if (!cleanSessionID || !Number.isFinite(seq) || seq <= 0) return

  const db = await openAttentionDB()
  if (!db) return

  await putRecord(db, attentionStore, {
    sessionID: cleanSessionID,
    seq,
    createdAt: Date.now(),
  })
}

export async function clearNotificationAttention(sessionID: string): Promise<void> {
  const cleanSessionID = sessionID.trim()
  if (!cleanSessionID) return

  const db = await openAttentionDB()
  if (!db) return

  await deleteRecord(db, attentionStore, cleanSessionID)
}

export function clearNotificationAttentionCacheForTest() {
  dbPromise = null
}

async function openAttentionDB(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return null
  }
  dbPromise ??= new Promise((resolve) => {
    const request = indexedDB.open(dbName, dbVersion)
    request.onerror = () => resolve(null)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(attentionStore)) {
        db.createObjectStore(attentionStore, { keyPath: 'sessionID' })
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
  return dbPromise
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
