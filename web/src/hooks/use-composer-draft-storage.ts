import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { saveComposerDraft, type ComposerDraft } from '@/lib/composer-drafts'

export function useComposerDraftStorage(sessionID: string | undefined, draft: ComposerDraft) {
  const { draft: content, selectedSkills } = draft
  const signature = useMemo(() => JSON.stringify({ draft: content, selectedSkills }), [content, selectedSkills])
  const previous = useRef({ sessionID, signature })
  const [storageError, setStorageError] = useState('')

  useEffect(() => {
    try {
      const changed = previous.current.sessionID !== sessionID || previous.current.signature !== signature
      // Mounting/restoring a tab is not an edit: do not replace another tab's
      // shared draft just because this one reopened with its own local text.
      saveComposerDraft(sessionID, JSON.parse(signature), changed)
      setStorageError('')
    } catch {
      setStorageError('Draft storage is unavailable. Copy your text before closing this tab.')
    }
    previous.current = { sessionID, signature }
  }, [sessionID, signature])

  const markRestored = useCallback((restored: ComposerDraft) => {
    // Receiving another tab's saved text is not a new edit to broadcast back.
    previous.current = { sessionID, signature: JSON.stringify(restored) }
  }, [sessionID])

  return { storageError, markRestored }
}
