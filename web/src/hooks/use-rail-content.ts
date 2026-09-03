import { useEffect, useState } from 'react'

export type RailContentMode = 'files' | 'conversation-map' | 'signal-field' | 'blocks' | 'blank'

export const railContentStorageKey = 'gorchestra.rail-content.v1'

export function useRailContentPreference() {
  const [mode, setMode] = useState<RailContentMode>(() => storedRailContentMode())

  useEffect(() => {
    window.localStorage.setItem(railContentStorageKey, mode)
  }, [mode])

  return { mode, setMode }
}

export function isRailContentMode(value: unknown): value is RailContentMode {
  return (
    value === 'files' ||
    value === 'conversation-map' ||
    value === 'signal-field' ||
    value === 'blocks' ||
    value === 'blank'
  )
}

function storedRailContentMode(): RailContentMode {
  if (typeof window === 'undefined') return 'files'
  const stored = window.localStorage.getItem(railContentStorageKey)
  return isRailContentMode(stored) ? stored : 'files'
}
