import { useEffect, useMemo, useRef, useState } from 'react'

type DraftVersion = { key: string; draft: string; updatedAt: number }
const changedEvent = 'gorchestra:draft-versions'
export const draftVersionsPrefix = (sessionID?: string) => `gorchestra.draft-version.v1.${encodeURIComponent(sessionID ?? '__default__')}.`

// Each editor writes its own slot. Concurrent tabs never overwrite each other's
// recoverable text, even if the shared "latest draft" pointer races.
export function useDraftVersions(sessionID: string | undefined, content: string) {
  const [writerID] = useState(() => crypto.randomUUID())
  const [revision, setRevision] = useState(0)
  const [storageError, setStorageError] = useState('')
  const previousContent = useRef(content)
  const prefix = draftVersionsPrefix(sessionID)
  const ownKey = prefix + writerID

  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1)
    window.addEventListener('storage', refresh)
    window.addEventListener('focus', refresh)
    window.addEventListener(changedEvent, refresh)
    return () => {
      window.removeEventListener('storage', refresh)
      window.removeEventListener('focus', refresh)
      window.removeEventListener(changedEvent, refresh)
    }
  }, [])

  useEffect(() => {
    if (previousContent.current === content) return
    previousContent.current = content
    try {
      window.localStorage.setItem(ownKey, JSON.stringify({ draft: content, updatedAt: Date.now() }))
      setStorageError('')
      window.dispatchEvent(new Event(changedEvent))
    } catch {
      setStorageError('Draft storage is unavailable. Copy your text before closing this tab.')
    }
  }, [content, ownKey])

  const versions = useMemo(() => {
    // revision tracks external writes; storage is intentionally read-only here.
    void revision
    const values: DraftVersion[] = []
    try {
      for (let index = 0; index < window.localStorage.length; index++) {
        const key = window.localStorage.key(index)!
        if (!key.startsWith(prefix) || key === ownKey) continue
        const value = JSON.parse(window.localStorage.getItem(key) ?? 'null') as DraftVersion | null
        if (value && typeof value.draft === 'string' && value.draft.trim() && value.draft !== content) {
          values.push({ ...value, key })
        }
      }
    } catch { /* The write effect exposes unavailable storage. */ }
    return values.sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((value, index, all) => all.findIndex((other) => other.draft === value.draft) === index)
  }, [content, ownKey, prefix, revision])

  function preserveCurrent() {
    if (!content.trim()) return
    // Selecting a saved copy is explicit, but keep the displaced local draft too.
    window.localStorage.setItem(prefix + crypto.randomUUID(), JSON.stringify({ draft: content, updatedAt: Date.now() }))
  }

  function discardVersion(version: DraftVersion) {
    try {
      // Do not delete a newer edit that arrived after this recovery list rendered.
      const saved = JSON.parse(window.localStorage.getItem(version.key) ?? 'null') as DraftVersion | null
      if (saved?.draft === version.draft) window.localStorage.removeItem(version.key)
      window.dispatchEvent(new Event(changedEvent))
    } catch { setStorageError('Unable to remove this saved draft.') }
  }

  return { versions, storageError, preserveCurrent, discardVersion }
}
