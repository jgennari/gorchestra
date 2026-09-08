import type { SkillReference } from '@/lib/api'

export type ComposerDraft = { draft: string; selectedSkills: SkillReference[] }
export const composerStorageKey = (sessionID?: string) => `gorchestra.session-composer.${sessionID || '__default__'}`
export const tabDraftStorageKey = (sessionID?: string) => `gorchestra.composer-draft.v1.${encodeURIComponent(sessionID || '__default__')}`

export function parseComposerDraft(value: string | null): ComposerDraft | null {
  try {
    const parsed = JSON.parse(value ?? 'null')
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.draft !== 'string' && !Array.isArray(parsed.selectedSkills)) return null
    const selectedSkills: SkillReference[] = Array.isArray(parsed.selectedSkills)
      ? parsed.selectedSkills.flatMap((reference: Partial<SkillReference> | null) =>
        reference && typeof reference.name === 'string' && reference.name.trim() &&
        typeof reference.path === 'string' && reference.path.trim()
          ? [{ name: reference.name.trim(), path: reference.path.trim() }] : [],
      ) : []
    return { draft: typeof parsed.draft === 'string' ? parsed.draft : '', selectedSkills }
  } catch {
    return null
  }
}

export function loadComposerDraft(sessionID?: string): ComposerDraft {
  // sessionStorage belongs to the tab, not the mounted editor. A deliberately
  // empty local draft wins too, so submitted/queued text cannot reappear on reload.
  try {
    const local = parseComposerDraft(window.sessionStorage.getItem(tabDraftStorageKey(sessionID)))
    if (local) return local
  } catch { /* Fall back to the last shared draft if tab storage is unavailable. */ }
  try {
    const shared = parseComposerDraft(window.localStorage.getItem(composerStorageKey(sessionID)))
    if (shared) return shared
  } catch { /* Keep the composer usable without browser storage. */ }
  return { draft: '', selectedSkills: [] }
}

export function saveComposerDraft(sessionID: string | undefined, draft: ComposerDraft, publish = true) {
  if (publish) {
    // Preserve the provider settings sharing this legacy storage record.
    let previous: object = {}
    try {
      const parsed = JSON.parse(window.localStorage.getItem(composerStorageKey(sessionID)) ?? '{}')
      if (parsed && typeof parsed === 'object') previous = parsed
    } catch { /* A malformed record should not prevent saving the new draft. */ }
    window.localStorage.setItem(composerStorageKey(sessionID), JSON.stringify({ ...previous, ...draft }))
  }
  window.sessionStorage.setItem(tabDraftStorageKey(sessionID), JSON.stringify(draft))
}
