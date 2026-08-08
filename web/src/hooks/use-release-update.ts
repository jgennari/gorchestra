import { useEffect, useState } from 'react'
import {
  checkForReleaseUpdate,
  emptyReleaseUpdate,
  gorchestraVersion,
  isReleaseBuild,
  type ReleaseUpdate,
} from '@/lib/releases'

export function useReleaseUpdate() {
  const [release, setRelease] = useState<ReleaseUpdate>(() => emptyReleaseUpdate())
  const [checking, setChecking] = useState(() => isReleaseBuild())

  useEffect(() => {
    if (!isReleaseBuild()) {
      return
    }

    let cancelled = false
    void checkForReleaseUpdate()
      .then((nextRelease) => {
        if (!cancelled) {
          setRelease(nextRelease)
        }
      })
      .catch(() => {
        // Update discovery should never make the application unavailable.
      })
      .finally(() => {
        if (!cancelled) {
          setChecking(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return {
    ...release,
    currentVersion: gorchestraVersion,
    checking,
  }
}
