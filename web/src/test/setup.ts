import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

vi.mock('react-virtuoso', async () => {
  const React = await import('react')

  type MockVirtuosoProps = {
    data?: unknown[]
    firstItemIndex?: number
    atBottomThreshold?: number
    className?: string
    role?: string
    'aria-label'?: string
    'aria-live'?: string
    'aria-relevant'?: string
    computeItemKey?: (index: number, item: unknown) => React.Key
    itemContent?: (index: number, item: unknown) => React.ReactNode
    followOutput?: (atBottom: boolean) => false | 'auto' | 'smooth'
    atBottomStateChange?: (atBottom: boolean) => void
    startReached?: (index: number) => void
    endReached?: (index: number) => void
    scrollerRef?: (ref: HTMLElement | null | Window) => unknown
    onWheel?: React.WheelEventHandler<HTMLDivElement>
    onTouchStart?: React.TouchEventHandler<HTMLDivElement>
    onTouchMove?: React.TouchEventHandler<HTMLDivElement>
    onTouchEnd?: React.TouchEventHandler<HTMLDivElement>
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>
  }

  const Virtuoso = React.forwardRef(function MockVirtuoso(props: MockVirtuosoProps, forwardedRef) {
    const data = React.useMemo(() => props.data ?? [], [props.data])
    const reportScroller = props.scrollerRef
    const scrollerRef = React.useRef<HTMLDivElement>(null)
    const previousDataRef = React.useRef(data)

    React.useImperativeHandle(forwardedRef, () => {
      const scrollToBottom = () => {
        const element = scrollerRef.current
        if (!element) return
        element.scrollTop = element.scrollHeight
        props.atBottomStateChange?.(true)
      }
      return {
        autoscrollToBottom: scrollToBottom,
        scrollToIndex: scrollToBottom,
      }
    })

    React.useLayoutEffect(() => {
      reportScroller?.(scrollerRef.current)
      return () => {
        reportScroller?.(null)
      }
    }, [reportScroller])

    React.useLayoutEffect(() => {
      const element = scrollerRef.current
      if (element && previousDataRef.current !== data) {
        const gap = element.scrollHeight - element.scrollTop - element.clientHeight
        const atBottom = gap <= (props.atBottomThreshold ?? 0)
        if (previousDataRef.current.length !== data.length && props.followOutput?.(atBottom)) {
          element.scrollTop = element.scrollHeight
        }
      }
      previousDataRef.current = data
    }, [data, props])

    return React.createElement(
      'div',
      {
        ref: scrollerRef,
        className: props.className,
        role: props.role,
        'aria-label': props['aria-label'],
        'aria-live': props['aria-live'],
        'aria-relevant': props['aria-relevant'],
        'data-testid': 'virtuoso-scroller',
        'data-first-item-index': props.firstItemIndex,
        onWheel: props.onWheel,
        onTouchStart: props.onTouchStart,
        onTouchMove: props.onTouchMove,
        onTouchEnd: props.onTouchEnd,
        onKeyDown: props.onKeyDown,
        onScroll: (event: React.UIEvent<HTMLDivElement>) => {
          const element = event.currentTarget
          const gap = element.scrollHeight - element.scrollTop - element.clientHeight
          const atBottom = gap <= (props.atBottomThreshold ?? 0)
          props.atBottomStateChange?.(atBottom)
          if (element.scrollTop <= 160) props.startReached?.(0)
          if (atBottom) props.endReached?.(Math.max(0, data.length - 1))
        },
      },
      React.createElement(
        'div',
        { 'data-testid': 'virtuoso-item-list' },
        data.map((item, index) =>
          React.createElement(
            'div',
            { key: props.computeItemKey?.(index, item) ?? index, 'data-index': index },
            props.itemContent?.(index, item),
          ),
        ),
      ),
    )
  })

  return { Virtuoso }
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
