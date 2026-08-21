import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

const viewportMargin = 16
const triggerGap = 8

export function useAnchoredPopover(open: boolean, preferredWidth = 384) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({
    position: 'absolute',
    visibility: 'hidden',
  })

  useLayoutEffect(() => {
    if (!open) return

    function updatePosition() {
      const trigger = triggerRef.current
      if (!trigger) return

      const rect = trigger.getBoundingClientRect()
      const boundary = trigger.closest('.command-workspace, section')?.getBoundingClientRect()
      const hasBoundary = boundary && boundary.width > 0 && boundary.height > 0
      const boundaryLeft = hasBoundary ? boundary.left : 0
      const boundaryRight = hasBoundary ? boundary.right : window.innerWidth
      const boundaryBottom = hasBoundary ? boundary.bottom : window.innerHeight
      const width = Math.min(preferredWidth, Math.max(0, boundaryRight - boundaryLeft - viewportMargin * 2))
      const viewportLeft = Math.min(
        Math.max(boundaryLeft + viewportMargin, rect.left),
        Math.max(boundaryLeft + viewportMargin, boundaryRight - width - viewportMargin),
      )
      const top = rect.height + triggerGap

      setPopoverStyle({
        position: 'absolute',
        left: viewportLeft - rect.left,
        top,
        width,
        maxHeight: Math.max(160, boundaryBottom - rect.bottom - triggerGap - viewportMargin),
      })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, preferredWidth])

  return { triggerRef, popoverStyle }
}
