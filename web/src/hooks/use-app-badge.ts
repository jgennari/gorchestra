import { useEffect } from 'react'

type BadgeNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}

export function useAppBadge(count: number) {
  useEffect(() => {
    const badgeNavigator = navigator as BadgeNavigator
    if (!badgeNavigator.setAppBadge) {
      return
    }

    async function updateBadge() {
      try {
        if (count > 0) {
          await badgeNavigator.setAppBadge(count)
          return
        }
        if (badgeNavigator.clearAppBadge) {
          await badgeNavigator.clearAppBadge()
          return
        }
        await badgeNavigator.setAppBadge(0)
      } catch {
        // Badging is optional platform chrome; keep the app functional if it fails.
      }
    }

    void updateBadge()
  }, [count])
}
