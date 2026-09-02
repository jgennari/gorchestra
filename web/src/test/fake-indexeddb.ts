export function createFakeIndexedDB() {
  const databases = new Map<string, FakeDB>()
  let operationDelayMs = 0
  const schedule = (callback: () => void) => globalThis.setTimeout(callback, operationDelayMs)
  return {
    setOperationDelay(delayMs: number) {
      operationDelayMs = Math.max(0, delayMs)
    },
    open(name: string, version = 1) {
      const request: FakeOpenRequest<FakeDB> = {}
      schedule(() => {
        let db = databases.get(name)
        const oldVersion = db?.version ?? 0
        const needsUpgrade = !db || version > oldVersion
        if (!db) {
          db = new FakeDB(version, schedule)
          databases.set(name, db)
        }
        if (version > db.version) db.version = version
        request.result = db
        request.transaction = db.transaction([...db.stores.keys()])
        if (needsUpgrade) request.onupgradeneeded?.({ oldVersion })
        request.onsuccess?.()
      })
      return request
    },
  }
}

type FakeRequest<T> = {
  result?: T
  error?: Error
  onsuccess?: () => void
  onerror?: () => void
}

type FakeOpenRequest<T> = FakeRequest<T> & {
  onblocked?: () => void
  onupgradeneeded?: (event: { oldVersion: number }) => void
  transaction?: FakeTransaction
}

type FakeStoreData = {
  values: Map<string, unknown>
  keyPath?: string
  indexes: Map<string, string>
}

class FakeDB {
  version: number
  stores = new Map<string, FakeStoreData>()
  onversionchange?: () => void
  private schedule: (callback: () => void) => number
  objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  }

  constructor(version: number, schedule: (callback: () => void) => number) {
    this.version = version
    this.schedule = schedule
  }

  createObjectStore(name: string, options?: { keyPath?: string }) {
    const data = { values: new Map<string, unknown>(), keyPath: options?.keyPath, indexes: new Map<string, string>() }
    this.stores.set(name, data)
    return new FakeObjectStore(data, new FakeTransactionController(this.schedule), this.schedule)
  }

  deleteObjectStore(name: string) {
    this.stores.delete(name)
  }

  transaction(storeNames: string | string[]) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames]
    const stores = new Map<string, FakeStoreData>()
    for (const storeName of names) {
      let store = this.stores.get(storeName)
      if (!store) {
        store = { values: new Map(), indexes: new Map() }
        this.stores.set(storeName, store)
      }
      stores.set(storeName, store)
    }
    return new FakeTransaction(stores, this.schedule)
  }

  close() {}
}

class FakeTransactionController {
  pending = 0
  completed = false
  oncomplete?: () => void
  private schedule: (callback: () => void) => number

  constructor(schedule: (callback: () => void) => number) {
    this.schedule = schedule
  }

  start() {
    this.pending += 1
  }

  finish() {
    this.pending -= 1
    this.schedule(() => {
      if (!this.completed && this.pending === 0) {
        this.completed = true
        this.oncomplete?.()
      }
    })
  }
}

class FakeTransaction {
  onerror?: () => void
  onabort?: () => void
  error?: Error
  private controller: FakeTransactionController
  private stores: Map<string, FakeStoreData>
  private schedule: (callback: () => void) => number

  constructor(stores: Map<string, FakeStoreData>, schedule: (callback: () => void) => number) {
    this.stores = stores
    this.schedule = schedule
    this.controller = new FakeTransactionController(schedule)
  }

  set oncomplete(callback: (() => void) | undefined) {
    this.controller.oncomplete = callback
  }

  get oncomplete() {
    return this.controller.oncomplete
  }

  objectStore(name?: string) {
    const store = name ? this.stores.get(name) : this.stores.values().next().value
    if (!store) throw new Error(`missing fake IndexedDB store ${name ?? ''}`)
    return new FakeObjectStore(store, this.controller, this.schedule)
  }

  abort() {
    this.error = new Error('fake IndexedDB transaction aborted')
    this.onabort?.()
  }
}

class FakeObjectStore {
  private store: FakeStoreData
  private transaction: FakeTransactionController
  private schedule: (callback: () => void) => number
  indexNames = {
    contains: (name: string) => this.store.indexes.has(name),
  }

  constructor(
    store: FakeStoreData,
    transaction: FakeTransactionController,
    schedule: (callback: () => void) => number,
  ) {
    this.store = store
    this.transaction = transaction
    this.schedule = schedule
  }

  createIndex(name: string, keyPath: string) {
    this.store.indexes.set(name, keyPath)
  }

  index(name: string) {
    const keyPath = this.store.indexes.get(name)
    if (!keyPath) throw new Error(`missing fake IndexedDB index ${name}`)
    return new FakeIndex(this.store, keyPath, this.transaction, this.schedule)
  }

  get(key: IDBValidKey) {
    const request: FakeRequest<unknown> = {}
    this.transaction.start()
    this.schedule(() => {
      request.result = this.store.values.get(String(key))
      request.onsuccess?.()
      this.transaction.finish()
    })
    return request
  }

  getAll() {
    const request: FakeRequest<unknown[]> = {}
    this.transaction.start()
    this.schedule(() => {
      request.result = [...this.store.values.values()]
      request.onsuccess?.()
      this.transaction.finish()
    })
    return request
  }

  put(value: unknown) {
    const key = recordKey(value, this.store.keyPath)
    if (key) this.store.values.set(key, value)
    this.transaction.start()
    this.schedule(() => this.transaction.finish())
  }

  delete(key: IDBValidKey) {
    this.store.values.delete(String(key))
    this.transaction.start()
    this.schedule(() => this.transaction.finish())
  }
}

class FakeIndex {
  private store: FakeStoreData
  private keyPath: string
  private transaction: FakeTransactionController
  private schedule: (callback: () => void) => number

  constructor(
    store: FakeStoreData,
    keyPath: string,
    transaction: FakeTransactionController,
    schedule: (callback: () => void) => number,
  ) {
    this.store = store
    this.keyPath = keyPath
    this.transaction = transaction
    this.schedule = schedule
  }

  getAll(query: IDBValidKey) {
    const request: FakeRequest<unknown[]> = {}
    this.transaction.start()
    this.schedule(() => {
      request.result = [...this.store.values.values()].filter(
        (value) => recordValue(value, this.keyPath) === query,
      )
      request.onsuccess?.()
      this.transaction.finish()
    })
    return request
  }
}

function recordKey(value: unknown, keyPath?: string) {
  if (!value || typeof value !== 'object') return ''
  if (keyPath) {
    const key = recordValue(value, keyPath)
    if (typeof key === 'string' || typeof key === 'number') return String(key)
  }
  if ('id' in value && typeof value.id === 'string') return value.id
  if ('sessionID' in value && typeof value.sessionID === 'string') return value.sessionID
  return ''
}

function recordValue(value: unknown, keyPath: string) {
  if (!value || typeof value !== 'object') return undefined
  return (value as Record<string, unknown>)[keyPath]
}
