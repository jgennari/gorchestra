import '@testing-library/jest-dom/vitest'

if (!window.localStorage) {
  const storage = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string) {
        return storage.has(key) ? (storage.get(key) ?? null) : null
      },
      setItem(key: string, value: string) {
        storage.set(key, String(value))
      },
      removeItem(key: string) {
        storage.delete(key)
      },
      clear() {
        storage.clear()
      },
      key(index: number) {
        return Array.from(storage.keys())[index] ?? null
      },
      get length() {
        return storage.size
      },
    },
  })
}
