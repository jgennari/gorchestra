import type { WorkspaceFileContent } from '@/lib/api'

export type FileDraft = { base: WorkspaceFileContent; draft: string }
const key = (sessionID: string, path: string) => `gorchestra.file-draft.v1.${encodeURIComponent(sessionID)}.${encodeURIComponent(path)}`

export function readFileDraft(sessionID: string, path: string): FileDraft | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(key(sessionID, path)) ?? 'null') as FileDraft | null
    return value && typeof value.draft === 'string' && typeof value.base?.content === 'string' ? value : null
  } catch { return null }
}

export function writeFileDraft(sessionID: string, base: WorkspaceFileContent, draft: string) {
  // Fail visibly in the editor if storage is unavailable; never claim durability.
  if (draft === base.content) window.localStorage.removeItem(key(sessionID, base.path))
  else window.localStorage.setItem(key(sessionID, base.path), JSON.stringify({ base, draft }))
}
