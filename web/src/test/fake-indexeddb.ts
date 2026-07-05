export function createFakeIndexedDB() {
  const databases = new Map<string, FakeDB>()
  return {
    open(name: string, version = 1) {
      const request: FakeRequest<FakeDB> = {}
      window.setTimeout(() => {
        let db = databases.get(name)
        const oldVersion = db?.version ?? 0
        const needsUpgrade = !db || version > oldVersion
        if (!db) {
          db = new FakeDB(version)
          databases.set(name, db)
        }
        if (version > db.version) {
          db.version = version
        }
        request.result = db
        if (needsUpgrade) {
          request.onupgradeneeded?.({ oldVersion })
        }
        request.onsuccess?.()
      }, 0)
      return request
    },
  }
}

type FakeRequest<T> = {
  result?: T
  onsuccess?: () => void
  onerror?: () => void
  onupgradeneeded?: (event: { oldVersion: number }) => void
}

class FakeDB {
  version: number
  stores = new Map<string, Map<string, unknown>>()
  objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  }

  constructor(version: number) {
    this.version = version
  }

  createObjectStore(name: string) {
    this.stores.set(name, new Map())
  }

  deleteObjectStore(name: string) {
    this.stores.delete(name)
  }

  transaction(storeName: string) {
    let store = this.stores.get(storeName)
    if (!store) {
      store = new Map()
      this.stores.set(storeName, store)
    }
    return new FakeTransaction(store)
  }
}

class FakeTransaction {
  oncomplete?: () => void
  onerror?: () => void
  private store: Map<string, unknown>

  constructor(store: Map<string, unknown>) {
    this.store = store
  }

  objectStore() {
    return new FakeObjectStore(this.store, () => this.oncomplete?.())
  }
}

class FakeObjectStore {
  private store: Map<string, unknown>
  private complete: () => void

  constructor(store: Map<string, unknown>, complete: () => void) {
    this.store = store
    this.complete = complete
  }

  get(key: string) {
    const request: FakeRequest<unknown> = {}
    window.setTimeout(() => {
      request.result = this.store.get(key)
      request.onsuccess?.()
    }, 0)
    return request
  }

  getAll() {
    const request: FakeRequest<unknown[]> = {}
    window.setTimeout(() => {
      request.result = [...this.store.values()]
      request.onsuccess?.()
    }, 0)
    return request
  }

  put(value: unknown) {
    const key = recordKey(value)
    if (key) {
      this.store.set(key, value)
    }
    window.setTimeout(this.complete, 0)
  }

  delete(key: string) {
    this.store.delete(key)
    window.setTimeout(this.complete, 0)
  }
}

function recordKey(value: unknown) {
  if (!value || typeof value !== 'object') return ''
  if ('id' in value && typeof value.id === 'string') return value.id
  if ('sessionID' in value && typeof value.sessionID === 'string') return value.sessionID
  return ''
}
