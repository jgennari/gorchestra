import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

vi.mock('@tanstack/react-virtual', async () => {
  const React = await import('react')

  type MockVirtualizerOptions = {
    count: number
    getScrollElement: () => HTMLDivElement | null
    estimateSize: (index: number) => number
    getItemKey: (index: number) => React.Key
    paddingEnd?: number
    scrollEndThreshold?: number
    followOnAppend?: boolean | ScrollBehavior
    onChange?: (instance: MockVirtualizer, sync: boolean) => void
  }

  type MockVirtualItem = {
    index: number
    key: React.Key
    start: number
    size: number
    end: number
  }

  type MockVirtualizer = {
    scrollDirection: 'forward' | 'backward' | null
    scrollRect: { width: number; height: number } | null
    getVirtualItems: () => MockVirtualItem[]
    getTotalSize: () => number
    getDistanceFromEnd: () => number
    isAtEnd: (threshold?: number) => boolean
    scrollToEnd: (_options?: { behavior?: ScrollBehavior }) => void
    measureElement: (_element: Element | null) => void
  }

  function useVirtualizer(options: MockVirtualizerOptions) {
    const optionsRef = React.useRef(options)
    optionsRef.current = options
    const scrollEndTimerRef = React.useRef<number | null>(null)
    const previousCountRef = React.useRef(options.count)
    const wasAtEndRef = React.useRef(true)
    const instanceRef = React.useRef<MockVirtualizer | null>(null)

    if (!instanceRef.current) {
      const instance: MockVirtualizer = {
        scrollDirection: null,
        scrollRect: null,
        getVirtualItems() {
          let start = 0
          return Array.from({ length: optionsRef.current.count }, (_, index) => {
            const size = optionsRef.current.estimateSize(index)
            const item = {
              index,
              key: optionsRef.current.getItemKey(index),
              start,
              size,
              end: start + size,
            }
            start += size
            return item
          })
        },
        getTotalSize() {
          const items = instance.getVirtualItems()
          return (items.at(-1)?.end ?? 0) + (optionsRef.current.paddingEnd ?? 0)
        },
        getDistanceFromEnd() {
          const element = optionsRef.current.getScrollElement()
          if (!element) return Number.POSITIVE_INFINITY
          const logicalOverride = element.dataset.mockVirtualDistanceFromEnd
          if (logicalOverride !== undefined) return Number(logicalOverride)
          return Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop)
        },
        isAtEnd(threshold = optionsRef.current.scrollEndThreshold ?? 0) {
          return instance.getDistanceFromEnd() <= threshold
        },
        scrollToEnd() {
          const element = optionsRef.current.getScrollElement()
          if (!element) return
          element.scrollTop = element.scrollHeight
        },
        measureElement() {},
      }
      instanceRef.current = instance
    }

    const instance = instanceRef.current
    instance.scrollRect = (() => {
      const element = options.getScrollElement()
      return element ? { width: element.clientWidth, height: element.clientHeight } : null
    })()

    React.useLayoutEffect(() => {
      const element = optionsRef.current.getScrollElement()
      if (!element) return
      let previousScrollTop = element.scrollTop
      let pendingWheelDirection: 'forward' | 'backward' | null = null

      const handleScroll = () => {
        const currentScrollTop = element.scrollTop
        instance.scrollDirection =
          pendingWheelDirection ??
          (currentScrollTop < previousScrollTop
            ? 'backward'
            : currentScrollTop > previousScrollTop
              ? 'forward'
              : instance.scrollDirection)
        pendingWheelDirection = null
        previousScrollTop = currentScrollTop
        instance.scrollRect = { width: element.clientWidth, height: element.clientHeight }
        wasAtEndRef.current = instance.isAtEnd()
        optionsRef.current.onChange?.(instance, true)
        if (scrollEndTimerRef.current !== null) window.clearTimeout(scrollEndTimerRef.current)
        scrollEndTimerRef.current = window.setTimeout(() => {
          scrollEndTimerRef.current = null
          optionsRef.current.onChange?.(instance, false)
          instance.scrollDirection = null
        }, 1)
      }
      const handleWheel = (event: WheelEvent) => {
        if (event.deltaY < 0) pendingWheelDirection = 'backward'
        if (event.deltaY > 0) pendingWheelDirection = 'forward'
      }

      element.addEventListener('scroll', handleScroll)
      element.addEventListener('wheel', handleWheel)
      return () => {
        element.removeEventListener('scroll', handleScroll)
        element.removeEventListener('wheel', handleWheel)
        if (scrollEndTimerRef.current !== null) window.clearTimeout(scrollEndTimerRef.current)
      }
    }, [instance])

    React.useLayoutEffect(() => {
      const countIncreased = options.count > previousCountRef.current
      previousCountRef.current = options.count
      if (countIncreased && options.followOnAppend && wasAtEndRef.current) instance.scrollToEnd()
    }, [instance, options.count, options.followOnAppend])

    return instance
  }

  return { useVirtualizer }
})

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
