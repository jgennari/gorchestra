import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  CircleAlert,
  Copy,
  Download,
  FileText,
  Loader2,
} from 'lucide-react'
import {
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent,
  type UIEvent,
  type WheelEvent,
} from 'react'
import ReactMarkdown from 'react-markdown'
import { Virtuoso } from 'react-virtuoso'
import remarkGfm from 'remark-gfm'
import type { AgentEvent } from '@/lib/api'
import type {
  ChatActionBreak,
  ChatDebugEvent,
  ChatRunError,
  ChatTimelineItem,
  ChatTranscriptAttachment,
  ChatTranscriptMessage,
  ChatTranscriptTool,
  ChatTranscriptToolContent,
} from '@/lib/events'
import { buildChatTimeline } from '@/lib/events'
import { clipboardCopyErrorMessage, copyText } from '@/lib/clipboard'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

const TRANSCRIPT_BOTTOM_BREATHING_ROOM_PX = 10
const AUTO_SCROLL_SNAP_MIN_PX = 240
const AUTO_SCROLL_SNAP_VIEWPORT_RATIO = 0.4
const INITIAL_TAIL_PIN_SETTLE_MS = 200
const TOUCH_SCROLL_SETTLE_MS = 100

type ChatActivityStatus = { kind: 'thinking' } | { kind: 'working'; since: string }

type Props = {
  events: AgentEvent[]
  loading?: boolean
  error?: string
  topInset?: 'none' | 'sessionHeader'
  bottomInsetHeight?: number
  pinToLatestOnMount?: boolean
  autoScroll?: boolean
  activityStatus?: ChatActivityStatus | null
  showDebugEvents?: boolean
  hasOlderEvents?: boolean
  hasNewerEvents?: boolean
  loadingOlderEvents?: boolean
  loadingNewerEvents?: boolean
  onLoadOlderEvents?: () => Promise<void> | void
  onLoadNewerEvents?: () => Promise<void> | void
  onJumpToLatest?: () => Promise<void> | void
  onFollowingTailChange?: (following: boolean) => void
  onOpenFilePath?: (path: string) => Promise<void> | void
  focusSeq?: number
}

type VirtualTimelineItem =
  | {
      kind: 'timeline'
      id: string
      item: ChatTimelineItem
      timelineIndex: number
    }
  | { kind: 'activity'; id: string; status: ChatActivityStatus }
  | { kind: 'error'; id: string; message: string }

type TranscriptContext = {
  tailClearanceHeight: number
}

type VirtualIndexState = {
  itemIDsKey: string
  itemIDs: string[]
  timelineItemIDs: string[]
  firstItemIndex: number
}

export function ChatTranscript({
  events,
  loading = false,
  error = '',
  topInset = 'none',
  bottomInsetHeight = 0,
  pinToLatestOnMount = false,
  autoScroll = false,
  activityStatus = null,
  showDebugEvents = false,
  hasOlderEvents = false,
  hasNewerEvents = false,
  loadingOlderEvents = false,
  loadingNewerEvents = false,
  onLoadOlderEvents,
  onLoadNewerEvents,
  onJumpToLatest,
  onFollowingTailChange,
  onOpenFilePath,
  focusSeq = 0,
}: Props) {
  const timeline = useMemo(() => buildChatTimeline(events, showDebugEvents), [events, showDebugEvents])
  const scrollerElementRef = useRef<HTMLElement | null>(null)
  const tailAlignmentFrameRef = useRef<number | null>(null)
  const touchTailSnapFrameRef = useRef<number | null>(null)
  const forceTailAlignmentRef = useRef(false)
  const autoScrollRef = useRef(autoScroll)
  const previousAutoScrollRef = useRef(autoScroll)
  const initiallyFollowingTail = pinToLatestOnMount || !hasNewerEvents
  const followingTailRef = useRef(initiallyFollowingTail)
  const initialTailPinPendingRef = useRef(pinToLatestOnMount)
  const tailPinCanSettleRef = useRef(true)
  const initialTailPinSettleTimerRef = useRef<number | null>(null)
  const scrollDirectionRef = useRef<'older' | 'latest' | null>(null)
  const pointerScrollActiveRef = useRef(false)
  const touchScrollActiveRef = useRef(false)
  const touchMomentumActiveRef = useRef(false)
  const touchScrollSettleTimerRef = useRef<number | null>(null)
  const touchTailResumePendingRef = useRef(false)
  const lastObservedScrollTopRef = useRef(0)
  const lastTouchYRef = useRef<number | null>(null)
  const resumeAttemptRef = useRef(0)
  const previousHasNewerEventsRef = useRef(hasNewerEvents)
  const [followingTail, setFollowingTailState] = useState(initiallyFollowingTail)
  const [touchTailResumePending, setTouchTailResumePending] = useState(false)
  const autoLoadOlderRef = useRef(false)
  const autoLoadNewerRef = useRef(false)
  const tailClearanceHeight = Math.max(
    TRANSCRIPT_BOTTOM_BREATHING_ROOM_PX,
    bottomInsetHeight + TRANSCRIPT_BOTTOM_BREATHING_ROOM_PX,
  )
  const alignTailNow = useCallback(() => {
    const scroller = scrollerElementRef.current
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }, [])
  const cancelInitialTailPinSettle = useCallback(() => {
    if (initialTailPinSettleTimerRef.current === null) return
    window.clearTimeout(initialTailPinSettleTimerRef.current)
    initialTailPinSettleTimerRef.current = null
  }, [])
  const settleInitialTailPin = useCallback(() => {
    cancelInitialTailPinSettle()
    initialTailPinSettleTimerRef.current = window.setTimeout(() => {
      initialTailPinSettleTimerRef.current = null
      if (
        !initialTailPinPendingRef.current ||
        !tailPinCanSettleRef.current ||
        !followingTailRef.current
      ) {
        return
      }
      alignTailNow()
      initialTailPinPendingRef.current = false
    }, INITIAL_TAIL_PIN_SETTLE_MS)
  }, [alignTailNow, cancelInitialTailPinSettle])
  const scheduleTailAlignment = useCallback((force = false) => {
    if (!force && (!autoScrollRef.current || !followingTailRef.current)) return
    forceTailAlignmentRef.current ||= force
    if (tailAlignmentFrameRef.current !== null) return
    tailAlignmentFrameRef.current = window.requestAnimationFrame(() => {
      tailAlignmentFrameRef.current = null
      const forced = forceTailAlignmentRef.current
      forceTailAlignmentRef.current = false
      if (!forced && (!autoScrollRef.current || !followingTailRef.current)) return
      alignTailNow()
    })
  }, [alignTailNow])

  const pauseFollowing = useCallback(() => {
    scrollDirectionRef.current = 'older'
    resumeAttemptRef.current += 1
    initialTailPinPendingRef.current = false
    tailPinCanSettleRef.current = true
    cancelInitialTailPinSettle()
    if (!followingTailRef.current) return
    followingTailRef.current = false
    setFollowingTailState(false)
    onFollowingTailChange?.(false)
    if (tailAlignmentFrameRef.current !== null) {
      window.cancelAnimationFrame(tailAlignmentFrameRef.current)
      tailAlignmentFrameRef.current = null
    }
    forceTailAlignmentRef.current = false
  }, [cancelInitialTailPinSettle, onFollowingTailChange])

  const resumeFollowing = useCallback(async () => {
    const attempt = resumeAttemptRef.current + 1
    resumeAttemptRef.current = attempt
    scrollDirectionRef.current = null
    initialTailPinPendingRef.current = true
    tailPinCanSettleRef.current = !hasNewerEvents

    if (!hasNewerEvents) {
      alignTailNow()
      followingTailRef.current = true
      setFollowingTailState(true)
      onFollowingTailChange?.(true)
      scheduleTailAlignment(true)
      settleInitialTailPin()
      return
    }

    followingTailRef.current = true
    setFollowingTailState(true)
    onFollowingTailChange?.(true)
    try {
      await onJumpToLatest?.()
    } finally {
      if (resumeAttemptRef.current === attempt && followingTailRef.current) {
        tailPinCanSettleRef.current = true
        alignTailNow()
        onFollowingTailChange?.(true)
        scheduleTailAlignment(true)
        settleInitialTailPin()
      }
    }
  }, [alignTailNow, hasNewerEvents, onFollowingTailChange, onJumpToLatest, scheduleTailAlignment, settleInitialTailPin])

  useLayoutEffect(() => {
    autoScrollRef.current = autoScroll
  }, [autoScroll])

  useLayoutEffect(() => {
    if (!initialTailPinPendingRef.current) return
    if (!followingTailRef.current) {
      initialTailPinPendingRef.current = false
      cancelInitialTailPinSettle()
      return
    }
    scheduleTailAlignment(true)
    if (loading) {
      cancelInitialTailPinSettle()
    } else {
      settleInitialTailPin()
    }
  }, [cancelInitialTailPinSettle, events, loading, scheduleTailAlignment, settleInitialTailPin, tailClearanceHeight])

  useLayoutEffect(() => {
    const wasAutoScrolling = previousAutoScrollRef.current
    previousAutoScrollRef.current = autoScroll
    if (!autoScroll) {
      if (wasAutoScrolling && followingTailRef.current) {
        initialTailPinPendingRef.current = true
        tailPinCanSettleRef.current = true
        scheduleTailAlignment(true)
        settleInitialTailPin()
      }
      return
    }
    scheduleTailAlignment()
  }, [activityStatus, autoScroll, error, events, scheduleTailAlignment, settleInitialTailPin, tailClearanceHeight])

  useEffect(() => {
    if (!autoScroll || !followingTail) return
    const itemList = scrollerElementRef.current?.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')
    if (!itemList || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => scheduleTailAlignment())
    observer.observe(itemList)
    return () => observer.disconnect()
  }, [autoScroll, followingTail, scheduleTailAlignment, timeline.length])

  useEffect(() => {
    return () => {
      if (tailAlignmentFrameRef.current !== null) {
        window.cancelAnimationFrame(tailAlignmentFrameRef.current)
        tailAlignmentFrameRef.current = null
      }
      if (touchTailSnapFrameRef.current !== null) {
        window.cancelAnimationFrame(touchTailSnapFrameRef.current)
        touchTailSnapFrameRef.current = null
      }
      if (touchScrollSettleTimerRef.current !== null) {
        window.clearTimeout(touchScrollSettleTimerRef.current)
        touchScrollSettleTimerRef.current = null
      }
      cancelInitialTailPinSettle()
      forceTailAlignmentRef.current = false
    }
  }, [cancelInitialTailPinSettle])

  const handleTotalListHeightChanged = useCallback(() => {
    if (!initialTailPinPendingRef.current || !followingTailRef.current) return
    scheduleTailAlignment(true)
    if (!loading && tailPinCanSettleRef.current) settleInitialTailPin()
  }, [loading, scheduleTailAlignment, settleInitialTailPin])

  useEffect(() => {
    const previouslyHadNewerEvents = previousHasNewerEventsRef.current
    previousHasNewerEventsRef.current = hasNewerEvents
    if (hasNewerEvents) {
      if (initialTailPinPendingRef.current) return
      if (!followingTailRef.current) return
      followingTailRef.current = false
      setFollowingTailState(false)
      return
    }
    if (
      previouslyHadNewerEvents &&
      !followingTailRef.current &&
      scrollDirectionRef.current === 'latest'
    ) {
      void resumeFollowing()
    }
  }, [hasNewerEvents, resumeFollowing])

  useEffect(() => {
    if (!loadingOlderEvents) {
      autoLoadOlderRef.current = false
    }
  }, [loadingOlderEvents])

  useEffect(() => {
    if (!loadingNewerEvents) autoLoadNewerRef.current = false
  }, [loadingNewerEvents])

  function requestOlderEvents() {
    const scroller = scrollerElementRef.current
    const pointerMovingOlder =
      pointerScrollActiveRef.current && Boolean(scroller && scroller.scrollTop < lastObservedScrollTopRef.current)
    const reviewingOlder =
      !followingTailRef.current || scrollDirectionRef.current === 'older' || pointerMovingOlder
    if (
      !reviewingOlder ||
      !hasOlderEvents ||
      loadingOlderEvents ||
      autoLoadOlderRef.current ||
      !onLoadOlderEvents
    ) {
      return Promise.resolve()
    }
    if (followingTailRef.current) pauseFollowing()
    autoLoadOlderRef.current = true
    return Promise.resolve(onLoadOlderEvents()).finally(() => {
      autoLoadOlderRef.current = false
    })
  }

  function requestNewerEvents() {
    const scroller = scrollerElementRef.current
    const pointerMovingLatest =
      pointerScrollActiveRef.current && Boolean(scroller && scroller.scrollTop > lastObservedScrollTopRef.current)
    const reviewingLatest = scrollDirectionRef.current === 'latest' || pointerMovingLatest
    if (
      reviewingLatest &&
      hasNewerEvents &&
      scroller &&
      isWithinTailSnapZone(scroller, tailClearanceHeight)
    ) {
      if (touchScrollActiveRef.current || touchMomentumActiveRef.current) {
        armTouchTailResume()
        if (touchMomentumActiveRef.current) scheduleTouchScrollSettle()
        return Promise.resolve()
      }
      return resumeFollowing()
    }
    if (
      !reviewingLatest ||
      !hasNewerEvents ||
      loadingNewerEvents ||
      autoLoadNewerRef.current ||
      !onLoadNewerEvents
    ) {
      return Promise.resolve()
    }
    autoLoadNewerRef.current = true
    return Promise.resolve(onLoadNewerEvents()).finally(() => {
      autoLoadNewerRef.current = false
    })
  }

  function armTouchTailResume() {
    if (touchTailResumePendingRef.current) return
    touchTailResumePendingRef.current = true
    setTouchTailResumePending(true)
  }

  function cancelTouchTailResume() {
    if (!touchTailResumePendingRef.current && !touchTailResumePending) return
    touchTailResumePendingRef.current = false
    setTouchTailResumePending(false)
  }

  function scheduleTouchScrollSettle() {
    if (touchScrollSettleTimerRef.current !== null) return
    touchScrollSettleTimerRef.current = window.setTimeout(() => {
      touchScrollSettleTimerRef.current = null
      touchMomentumActiveRef.current = false
      if (!touchTailResumePendingRef.current) return
      touchTailResumePendingRef.current = false
      void resumeFollowing().finally(() => setTouchTailResumePending(false))
    }, TOUCH_SCROLL_SETTLE_MS)
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    pointerScrollActiveRef.current = false
    touchScrollActiveRef.current = false
    touchMomentumActiveRef.current = false
    if (touchScrollSettleTimerRef.current !== null) {
      window.clearTimeout(touchScrollSettleTimerRef.current)
      touchScrollSettleTimerRef.current = null
    }
    cancelTouchTailResume()
    if (event.deltaY < 0) {
      pauseFollowing()
    } else if (event.deltaY > 0) {
      scrollDirectionRef.current = 'latest'
    }
  }

  function handleTouchStart(event: TouchEvent<HTMLDivElement>) {
    touchScrollActiveRef.current = true
    touchMomentumActiveRef.current = false
    if (touchScrollSettleTimerRef.current !== null) {
      window.clearTimeout(touchScrollSettleTimerRef.current)
      touchScrollSettleTimerRef.current = null
    }
    lastTouchYRef.current = event.touches[0]?.clientY ?? null
  }

  function handleTouchMove(event: TouchEvent<HTMLDivElement>) {
    const touchY = event.touches[0]?.clientY
    if (touchY === undefined) return
    if (lastTouchYRef.current !== null) {
      if (touchY > lastTouchYRef.current) {
        if (touchTailSnapFrameRef.current !== null) {
          window.cancelAnimationFrame(touchTailSnapFrameRef.current)
          touchTailSnapFrameRef.current = null
        }
        cancelTouchTailResume()
        pauseFollowing()
      } else if (touchY < lastTouchYRef.current) {
        scrollDirectionRef.current = 'latest'
        const scroller = event.currentTarget
        if (touchTailSnapFrameRef.current !== null) window.cancelAnimationFrame(touchTailSnapFrameRef.current)
        touchTailSnapFrameRef.current = window.requestAnimationFrame(() => {
          touchTailSnapFrameRef.current = null
          if (
            scrollDirectionRef.current === 'latest' &&
            (!followingTailRef.current || hasNewerEvents) &&
            isWithinTailSnapZone(scroller, tailClearanceHeight)
          ) {
            armTouchTailResume()
          }
        })
      }
    }
    lastTouchYRef.current = touchY
  }

  function handleTouchEnd(event: TouchEvent<HTMLDivElement>) {
    const scroller = event.currentTarget
    lastTouchYRef.current = null
    touchScrollActiveRef.current = false
    touchMomentumActiveRef.current = true
    scheduleTouchScrollSettle()
    if (touchTailSnapFrameRef.current !== null) window.cancelAnimationFrame(touchTailSnapFrameRef.current)
    touchTailSnapFrameRef.current = window.requestAnimationFrame(() => {
      touchTailSnapFrameRef.current = null
      if (
        scrollDirectionRef.current === 'latest' &&
        (!followingTailRef.current || hasNewerEvents) &&
        isWithinTailSnapZone(scroller, tailClearanceHeight)
      ) {
        armTouchTailResume()
        scheduleTouchScrollSettle()
      }
    })
  }

  function handleScrollKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const movingOlder =
      event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home' || (event.key === ' ' && event.shiftKey)
    const movingLatest =
      event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === 'End' || (event.key === ' ' && !event.shiftKey)
    if (movingOlder) pauseFollowing()
    if (movingLatest) scrollDirectionRef.current = 'latest'
  }

  function handleScrollerPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
    pointerScrollActiveRef.current = true
    scrollDirectionRef.current = null
    lastObservedScrollTopRef.current = event.currentTarget.scrollTop
  }

  function handleScrollerPointerEnd() {
    pointerScrollActiveRef.current = false
  }

  function handleAtBottomChange(atBottom: boolean) {
    if (
      !atBottom ||
      scrollDirectionRef.current !== 'latest' ||
      (followingTailRef.current && !hasNewerEvents)
    ) {
      return
    }
    if (touchScrollActiveRef.current || touchMomentumActiveRef.current) {
      armTouchTailResume()
      if (touchMomentumActiveRef.current) scheduleTouchScrollSettle()
      return
    }
    void resumeFollowing()
  }

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    const scroller = event.currentTarget
    const previousScrollTop = lastObservedScrollTopRef.current
    const currentScrollTop = scroller.scrollTop
    const observedDirection =
      currentScrollTop < previousScrollTop ? 'older' : currentScrollTop > previousScrollTop ? 'latest' : null
    lastObservedScrollTopRef.current = currentScrollTop
    const direction = scrollDirectionRef.current ?? (pointerScrollActiveRef.current ? observedDirection : null)

    if (direction === 'older') {
      cancelTouchTailResume()
      pauseFollowing()
      return
    }
    if (direction !== 'latest' || (followingTailRef.current && !hasNewerEvents)) return
    if (isWithinTailSnapZone(scroller, tailClearanceHeight)) {
      if (touchScrollActiveRef.current || touchMomentumActiveRef.current) {
        armTouchTailResume()
        if (touchMomentumActiveRef.current) scheduleTouchScrollSettle()
      } else {
        void resumeFollowing()
      }
    } else if (hasNewerEvents) {
      void requestNewerEvents()
    }
  }

  const virtualItems = useMemo<VirtualTimelineItem[]>(() => {
    const items: VirtualTimelineItem[] = []
    for (const [timelineIndex, item] of timeline.entries()) {
      items.push({ kind: 'timeline', id: item.id, item, timelineIndex })
    }
    if (activityStatus && !hasNewerEvents) items.push({ kind: 'activity', id: 'activity', status: activityStatus })
    if (error) items.push({ kind: 'error', id: 'chat-error', message: error })
    return items
  }, [
    activityStatus,
    error,
    hasNewerEvents,
    timeline,
  ])
  const virtualItemIDs = virtualItems.map((item) => item.id)
  const timelineItemIDs = virtualItems.filter((item) => item.kind === 'timeline').map((item) => item.id)
  const virtualItemIDsKey = virtualItemIDs.join('\0')
  const [virtualIndexState, setVirtualIndexState] = useState<VirtualIndexState>(() => ({
    itemIDsKey: virtualItemIDsKey,
    itemIDs: virtualItemIDs,
    timelineItemIDs,
    firstItemIndex: 1_000_000,
  }))
  let firstItemIndex = virtualIndexState.firstItemIndex
  if (virtualIndexState.itemIDsKey !== virtualItemIDsKey) {
    const anchorID = virtualIndexState.timelineItemIDs.find((id) => virtualItemIDs.includes(id))
    firstItemIndex = anchorID
      ? virtualIndexState.firstItemIndex +
        virtualIndexState.itemIDs.indexOf(anchorID) -
        virtualItemIDs.indexOf(anchorID)
      : 1_000_000
    setVirtualIndexState({
      itemIDsKey: virtualItemIDsKey,
      itemIDs: virtualItemIDs,
      timelineItemIDs,
      firstItemIndex,
    })
  }

  if (loading && timeline.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        Loading chat history...
      </div>
    )
  }

  if (timeline.length === 0 && !activityStatus && !error) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        No messages yet. Submit a prompt to start the chat.
      </div>
    )
  }

  const latestMessageIndex = timeline.reduce((latest, item, index) => (item.kind === 'message' ? index : latest), -1)
  const messageDateBreakIndexes = messageDateBreaks(timeline)
  function updateChatGlow(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return

    const bounds = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.setProperty('--chat-glow-x', `${event.clientX - bounds.left}px`)
    event.currentTarget.style.setProperty('--chat-glow-y', `${event.clientY - bounds.top}px`)
    event.currentTarget.dataset.glowActive = 'true'
  }

  function hideChatGlow(event: ReactPointerEvent<HTMLDivElement>) {
    delete event.currentTarget.dataset.glowActive
  }

  return (
    <div
      className="chat-canvas relative h-full min-h-0 overflow-hidden"
      onPointerEnter={updateChatGlow}
      onPointerMove={updateChatGlow}
      onPointerLeave={hideChatGlow}
      onPointerCancel={hideChatGlow}
    >
      <Virtuoso<VirtualTimelineItem, TranscriptContext>
        scrollerRef={(element) => {
          scrollerElementRef.current = element instanceof HTMLElement ? element : null
        }}
        className="chat-scroll-area subtle-scrollbar h-full min-h-0 overscroll-y-none"
        data={virtualItems}
        context={{ tailClearanceHeight }}
        components={transcriptComponents}
        computeItemKey={(_, item) => item.id}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
        alignToBottom
        followOutput={false}
        atBottomThreshold={tailClearanceHeight + AUTO_SCROLL_SNAP_MIN_PX}
        atBottomStateChange={handleAtBottomChange}
        totalListHeightChanged={handleTotalListHeightChanged}
        increaseViewportBy={{ top: 600, bottom: 800 }}
        overscan={200}
        startReached={() => void requestOlderEvents()}
        endReached={() => void requestNewerEvents()}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onKeyDown={handleScrollKeyDown}
        onPointerDown={handleScrollerPointerDown}
        onPointerUp={handleScrollerPointerEnd}
        onPointerCancel={handleScrollerPointerEnd}
        onScroll={handleScroll}
        role="log"
        aria-label="Chat messages"
        aria-live="polite"
        aria-relevant="additions text"
        itemContent={(_, virtualItem) => {
          if (virtualItem.kind === 'activity') {
            return (
              <div className="px-4 pt-3">
                <ActivityIndicatorRow status={virtualItem.status} />
              </div>
            )
          }
          if (virtualItem.kind === 'error') {
            return (
              <div className="px-4 pt-3">
                <div
                  role="alert"
                  data-testid="chat-transcript-error"
                  className="mx-auto flex w-fit max-w-[min(36rem,100%)] items-center justify-center gap-2 rounded-lg border border-destructive/25 bg-destructive/[0.06] px-3 py-2 text-center text-xs shadow-sm"
                >
                  <CircleAlert className="size-3.5 shrink-0 text-destructive/80" aria-hidden="true" />
                  <span className="shrink-0 font-medium text-destructive/90">Chat issue</span>
                  <span className="min-w-0 break-words text-muted-foreground">{virtualItem.message}</span>
                </div>
              </div>
            )
          }
          const { item, timelineIndex } = virtualItem
          return (
            <div
              data-transcript-row={item.id}
              className={cn(
                'px-4',
                timelineItemContainsSeq(item, focusSeq) && 'rounded-xl bg-primary/8 py-2 ring-2 ring-primary/45',
                timelineIndex === 0 && !hasOlderEvents && topInset === 'sessionHeader' && 'lg:pt-24',
                timelineRowSpacing(
                  item,
                  timeline[timelineIndex - 1],
                  timelineIndex > 0 || hasOlderEvents || loadingOlderEvents,
                ),
              )}
            >
              <ChatTimelineRow
                item={item}
                focusSeq={focusSeq}
                collapseExtraTools={item.kind === 'message' && timelineIndex < latestMessageIndex}
                showMessageDate={messageDateBreakIndexes.has(timelineIndex)}
                onOpenFilePath={onOpenFilePath}
              />
            </div>
          )
        }}
      />
      {(!followingTail || hasNewerEvents) && !touchTailResumePending ? (
        <div
          className="pointer-events-none absolute inset-x-0 z-20 flex justify-center px-4"
          style={{ bottom: `${Math.max(16, bottomInsetHeight + 12)}px` }}
        >
          <button
            type="button"
            className="pointer-events-auto inline-flex h-9 items-center gap-2 rounded-full border border-border/70 bg-background/90 px-3.5 text-xs font-medium text-foreground shadow-lg shadow-black/10 backdrop-blur transition-colors hover:bg-background"
            aria-label="Scroll to latest and resume auto-scroll"
            onClick={() => void resumeFollowing()}
          >
            <ChevronDown className="size-3.5" aria-hidden="true" />
            Jump to latest
          </button>
        </div>
      ) : null}
    </div>
  )
}

function isWithinTailSnapZone(scroller: HTMLElement, tailClearanceHeight: number) {
  const distanceFromBottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop)
  const snapDistance =
    tailClearanceHeight + Math.max(AUTO_SCROLL_SNAP_MIN_PX, scroller.clientHeight * AUTO_SCROLL_SNAP_VIEWPORT_RATIO)
  return distanceFromBottom <= snapDistance
}

function TranscriptFooter({ context }: { context: TranscriptContext }) {
  return (
    <div
      data-testid="chat-transcript-tail-spacer"
      aria-hidden="true"
      style={{ height: `${context.tailClearanceHeight}px` }}
    />
  )
}

const transcriptComponents = {
  Footer: TranscriptFooter,
}

function ActivityIndicatorRow({ status }: { status: ChatActivityStatus }) {
  if (status.kind === 'thinking') {
    return <ThinkingIndicatorRow />
  }
  return <WorkingIndicatorRow since={status.since} />
}

function ThinkingIndicatorRow() {
  const gradientId = `thinking-gradient-${useId().replace(/:/g, '')}`

  return (
    <article className="flex justify-start">
      <div
        role="status"
        aria-label="Thinking"
        aria-live="polite"
        className="thinking-indicator inline-flex max-w-full sm:max-w-[min(48rem,90%)] items-center gap-2 px-1 py-0.5 text-sm font-medium"
      >
        <Brain className="thinking-indicator__icon size-4" aria-hidden="true" stroke={`url(#${gradientId})`}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="24" y2="0" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="hsl(var(--muted-foreground))" />
              <stop offset="42%" stopColor="hsl(var(--primary))" />
              <stop offset="58%" stopColor="hsl(var(--glow))" />
              <stop offset="100%" stopColor="hsl(var(--muted-foreground))" />
              <animateTransform
                attributeName="gradientTransform"
                type="translate"
                values="-24 0; 24 0; -24 0"
                dur="2.4s"
                repeatCount="indefinite"
              />
            </linearGradient>
          </defs>
        </Brain>
        <span className="thinking-indicator__text">Thinking</span>
      </div>
    </article>
  )
}

function WorkingIndicatorRow({ since }: { since: string }) {
  const label = useWorkingLabel(since)

  return (
    <article className="flex justify-start">
      <div
        role="status"
        aria-label={label}
        aria-live="polite"
        className="thinking-indicator inline-flex max-w-full sm:max-w-[min(48rem,90%)] items-center gap-2 px-1 py-0.5 text-sm font-medium"
      >
        <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
        <span className="thinking-indicator__text">{label}</span>
      </div>
    </article>
  )
}

function useWorkingLabel(since: string) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [since])

  const startedAt = Date.parse(since)
  if (!Number.isFinite(startedAt)) {
    return 'Working'
  }

  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (elapsedSeconds < 1) {
    return 'Working'
  }
  return `Working for ${elapsedSeconds} ${elapsedSeconds === 1 ? 'second' : 'seconds'}`
}

function timelineRowSpacing(item: ChatTimelineItem, previous: ChatTimelineItem | undefined, hasPriorRow: boolean) {
  if (!hasPriorRow) {
    return ''
  }
  if (item.kind === 'debug' && previous?.kind === 'debug') {
    return 'mt-1'
  }
  if (item.kind === 'error' && previous?.kind === 'error') {
    return 'mt-2'
  }
  if (item.kind === 'debug' || previous?.kind === 'debug') {
    return 'mt-2'
  }
  if (item.kind === 'error' || previous?.kind === 'error') {
    return 'mt-3'
  }
  return 'mt-5'
}

function timelineItemContainsSeq(item: ChatTimelineItem, seq: number) {
  return seq > 0 && seq >= item.startSeq && seq <= item.endSeq
}

function ChatTimelineRow({
  item,
  collapseExtraTools,
  showMessageDate,
  onOpenFilePath,
  focusSeq,
}: {
  item: ChatTimelineItem
  collapseExtraTools: boolean
  showMessageDate: boolean
  onOpenFilePath?: (path: string) => Promise<void> | void
  focusSeq: number
}) {
  if (item.kind === 'action') {
    return <ActionBreakRow action={item.action} />
  }
  if (item.kind === 'debug') {
    return <DebugEventRow event={item.event} />
  }
  if (item.kind === 'error') {
    return <RunErrorRow error={item.error} />
  }
  return (
    <ChatMessageRow
      message={item.message}
      collapseExtraTools={collapseExtraTools}
      showDate={showMessageDate}
      onOpenFilePath={onOpenFilePath}
      focusSeq={focusSeq}
    />
  )
}

function ActionBreakRow({ action }: { action: ChatActionBreak }) {
  return (
    <div className="py-1" role="separator" aria-label={action.label}>
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border/70" aria-hidden="true" />
        <span className="rounded-full border border-border/70 bg-background/85 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground shadow-sm">
          {action.label}
        </span>
        <div className="h-px flex-1 bg-border/70" aria-hidden="true" />
      </div>
      {action.detail ? (
        <p
          className="mx-auto mt-1 max-w-[min(42rem,calc(100%-2rem))] truncate text-center font-mono text-[10px] text-muted-foreground"
          title={action.detail}
        >
          {action.detail}
        </p>
      ) : null}
    </div>
  )
}

function ChatMessageRow({
  message,
  collapseExtraTools,
  showDate,
  onOpenFilePath,
  focusSeq,
}: {
  message: ChatTranscriptMessage
  collapseExtraTools: boolean
  showDate: boolean
  onOpenFilePath?: (path: string) => Promise<void> | void
  focusSeq: number
}) {
  const user = message.role === 'user'
  const plan = message.variant === 'plan'
  const [showAllTools, setShowAllTools] = useState(false)
  const [messageCopied, setMessageCopied] = useState(false)
  const [messageCopyFailed, setMessageCopyFailed] = useState(false)
  const shouldCollapseTools = collapseExtraTools && message.tools.length > 3
  const visibleTools = !shouldCollapseTools || showAllTools ? message.tools : message.tools.slice(0, 3)
  const hasHiddenTools = message.tools.length > visibleTools.length
  const timestampValue = messageTimestamp(message)
  const timestamp = formatMessageTimestamp(timestampValue, showDate)
  const turnDuration = formatTurnDuration(message.durationMs)
  const showMessageCopy = Boolean(message.text)
  const focusedTool = message.tools.find((tool) => focusSeq >= tool.startSeq && focusSeq <= tool.endSeq)

  useEffect(() => {
    if (focusedTool) setShowAllTools(true)
  }, [focusedTool])

  async function handleMessageCopy() {
    if (!message.text) {
      return
    }
    setMessageCopyFailed(false)
    try {
      await copyText(message.text)
      setMessageCopied(true)
      window.setTimeout(() => setMessageCopied(false), 1200)
    } catch {
      setMessageCopied(false)
      setMessageCopyFailed(true)
    }
  }

  return (
    <article className={cn('flex', user ? 'justify-end' : 'justify-start')} data-message-variant={message.variant}>
      <div className="relative inline-block max-w-full sm:max-w-[min(48rem,90%)]">
        {timestamp ? (
          <div className="flex h-4 items-center justify-end gap-0.5 px-1 text-[10px] leading-none text-muted-foreground/55">
            {turnDuration ? (
              <>
                <span className="tabular-nums" aria-label={`Total turn time ${turnDuration}`}>
                  {turnDuration}
                </span>
                <span aria-hidden="true">·</span>
              </>
            ) : null}
            <time className="font-normal tabular-nums" dateTime={timestampValue}>
              {timestamp}
            </time>
            {messageCopyFailed ? (
              <span role="alert" title={clipboardCopyErrorMessage} className="ml-1 whitespace-nowrap text-destructive">
                Copy failed
              </span>
            ) : null}
            {showMessageCopy ? (
              <button
                type="button"
                aria-label="Copy message"
                title={messageCopied ? 'Copied' : 'Copy message'}
                onClick={() => void handleMessageCopy()}
                className="inline-flex size-4 items-center justify-center rounded text-muted-foreground/45 transition-colors hover:bg-muted/55 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {messageCopied ? (
                  <Check className="size-3" aria-hidden="true" />
                ) : (
                  <Copy className="size-3" aria-hidden="true" />
                )}
              </button>
            ) : null}
          </div>
        ) : null}
        <div
          className={cn(
            'rounded-lg px-3.5 py-3 text-sm shadow-sm',
            user
              ? 'border border-primary/30 bg-primary text-primary-foreground shadow-[0_12px_30px_hsl(var(--primary)/0.16)]'
              : plan
                ? 'border border-l-4 border-amber-300/75 border-l-amber-400 bg-amber-50/85 text-amber-950 shadow-[0_12px_30px_hsl(43_96%_56%/0.12)] dark:border-amber-400/35 dark:border-l-amber-300 dark:bg-amber-400/10 dark:text-amber-100'
                : 'command-card border text-card-foreground',
          )}
        >
          {plan ? (
            <div className="mb-1.5 flex items-center gap-2 text-xs leading-none font-medium text-amber-800/90 dark:text-amber-200/90">
              {plan ? <ClipboardList className="size-3.5 shrink-0" aria-hidden="true" /> : null}
              <span>{message.label}</span>
            </div>
          ) : null}

          {message.skills.length > 0 ? <MessageSkills skills={message.skills} /> : null}

          {message.attachments.length > 0 ? <MessageAttachments attachments={message.attachments} /> : null}

          {message.text ? (
            <MarkdownContent
              content={message.text}
              variant={user ? 'inverted' : plan ? 'plan' : 'default'}
              onOpenFilePath={onOpenFilePath}
            />
          ) : user && (message.attachments.length > 0 || message.skills.length > 0) ? null : (
            <p className="text-muted-foreground">Working...</p>
          )}
        </div>

        {message.tools.length > 0 ? (
          <div
            className={cn(
              'mt-2 border-l pl-3',
              plan ? 'border-amber-300/70 dark:border-amber-400/35' : 'border-border/80',
            )}
          >
            {visibleTools.map((tool) => (
              <ToolCallRow
                key={tool.id}
                tool={tool}
                onOpenFilePath={onOpenFilePath}
                focused={tool.id === focusedTool?.id}
              />
            ))}
            {shouldCollapseTools ? (
              <button
                type="button"
                className="relative z-10 -ml-1 flex min-h-6 w-fit items-center gap-0.5 rounded px-1 py-1 text-[10px] font-normal leading-4 text-muted-foreground/65 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={showAllTools}
                onClick={() => setShowAllTools((current) => !current)}
              >
                {hasHiddenTools ? (
                  <ChevronRight className="size-2.5" aria-hidden="true" />
                ) : (
                  <ChevronDown className="size-2.5" aria-hidden="true" />
                )}
                {hasHiddenTools ? `Show ${message.tools.length - visibleTools.length} More` : 'Show Less'}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  )
}

function MessageSkills({ skills }: { skills: ChatTranscriptMessage['skills'] }) {
  return (
    <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Invoked skills">
      {skills.map((skill) => (
        <span
          key={`${skill.name}\u0000${skill.path}`}
          className="rounded-full border border-current/25 bg-background/15 px-2 py-0.5 font-mono text-[11px] font-medium"
          title={skill.path}
        >
          ${skill.name}
        </span>
      ))}
    </div>
  )
}

function MessageAttachments({ attachments }: { attachments: ChatTranscriptAttachment[] }) {
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {attachments.map((attachment, index) => (
        <ImageAttachmentPreview key={`${attachment.name}-${index}`} attachment={attachment} />
      ))}
    </div>
  )
}

function ImageAttachmentPreview({ attachment }: { attachment: ChatTranscriptAttachment }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="block overflow-hidden rounded-md border border-border/70 bg-background/80 transition-colors hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Preview ${attachment.name}`}
        >
          <img src={attachment.sourceURL} alt={attachment.name} className="h-24 w-24 object-cover" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] gap-4 overflow-hidden p-4 sm:max-w-5xl">
        <div className="flex min-w-0 items-start justify-between gap-3 pr-8">
          <div className="min-w-0">
            <DialogTitle className="truncate text-base">{attachment.name}</DialogTitle>
            <DialogDescription>{formatAttachmentSize(attachment.sizeBytes) || attachment.mediaType}</DialogDescription>
          </div>
          <a
            href={attachment.sourceURL}
            download={attachment.name}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-border/80 bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Download className="size-4" aria-hidden="true" />
            Download
          </a>
        </div>
        <div className="flex min-h-0 max-h-[calc(100dvh-9rem)] items-center justify-center overflow-auto rounded-md border border-border/70 bg-black/90">
          <img
            src={attachment.sourceURL}
            alt={attachment.name}
            className="max-h-[calc(100dvh-10rem)] max-w-full object-contain"
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function formatAttachmentSize(sizeBytes: number) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return ''
  }
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

function messageDateBreaks(timeline: ChatTimelineItem[]) {
  const breaks = new Set<number>()
  let previousMessageDate: Date | null = null

  for (const [index, item] of timeline.entries()) {
    if (item.kind !== 'message') continue
    const currentMessageDate = parseMessageDate(messageTimestamp(item.message))
    if (!currentMessageDate) continue
    if (previousMessageDate && !sameLocalCalendarDay(previousMessageDate, currentMessageDate)) {
      breaks.add(index)
    }
    previousMessageDate = currentMessageDate
  }

  return breaks
}

function parseMessageDate(value: string) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function sameLocalCalendarDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

function messageTimestamp(message: ChatTranscriptMessage) {
  return message.role === 'assistant' && !message.streaming && message.completedAt
    ? message.completedAt
    : message.createdAt
}

function formatTurnDuration(durationMs: number | null) {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return ''
  const totalSeconds = Math.round(durationMs / 1000)
  if (totalSeconds < 60) return `${totalSeconds} sec`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds ? `${minutes} min ${seconds} sec` : `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours} hr ${remainingMinutes} min` : `${hours} hr`
}

function formatMessageTimestamp(value: string, includeDate = false) {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const options: Intl.DateTimeFormatOptions = includeDate
    ? { dateStyle: 'short', timeStyle: 'short' }
    : { timeStyle: 'short' }
  return new Intl.DateTimeFormat(undefined, options).format(date)
}

type MarkdownVariant = 'default' | 'inverted' | 'plan'

function MarkdownContent({
  content,
  variant,
  onOpenFilePath,
}: {
  content: string
  variant: MarkdownVariant
  onOpenFilePath?: (path: string) => Promise<void> | void
}) {
  const inverted = variant === 'inverted'
  const plan = variant === 'plan'

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => (
          <p className="my-2 first:mt-0 last:mb-0 whitespace-pre-wrap break-words leading-relaxed">{children}</p>
        ),
        a: ({ children, href }) => {
          const filePath = markdownFilePathFromHref(href)
          const opensFileEditor = Boolean(filePath && onOpenFilePath)

          return (
            <a
              href={href}
              target={opensFileEditor ? undefined : '_blank'}
              rel={opensFileEditor ? undefined : 'noreferrer'}
              className={cn(
                'underline underline-offset-2',
                inverted ? 'text-primary-foreground' : plan ? 'text-amber-700 dark:text-amber-200' : 'text-primary',
              )}
              onClick={
                opensFileEditor
                  ? (event) => {
                      event.preventDefault()
                      void onOpenFilePath?.(filePath)
                    }
                  : undefined
              }
            >
              {children}
            </a>
          )
        },
        ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote
            className={cn(
              'my-2 border-l-2 pl-3 italic',
              inverted
                ? 'border-primary-foreground/50'
                : plan
                  ? 'border-amber-400/70 text-amber-900/80 dark:border-amber-300/50 dark:text-amber-100/80'
                  : 'border-border text-muted-foreground',
            )}
          >
            {children}
          </blockquote>
        ),
        code: ({ children, className }) => {
          const code = childrenToString(children)
          const block = className?.startsWith('language-') || code.endsWith('\n')
          if (block) {
            return (
              <CodeBlock code={code} className={className} variant={variant}>
                {children}
              </CodeBlock>
            )
          }
          return (
            <code
              className={cn(
                'rounded border px-1 py-0.5 font-mono text-[0.85em]',
                inverted
                  ? 'border-primary-foreground/20 bg-primary-foreground/15'
                  : plan
                    ? 'border-amber-300/70 bg-amber-100/85 text-amber-950 dark:border-amber-300/35 dark:bg-amber-300/14 dark:text-amber-50'
                    : 'border-transparent bg-muted',
              )}
            >
              {children}
            </code>
          )
        },
        pre: ({ children }) => <>{children}</>,
        h1: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h3>,
        h2: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h3>,
        h3: ({ children }) => <h3 className="mb-2 mt-3 text-sm font-semibold first:mt-0">{children}</h3>,
        hr: () => (
          <hr
            className={cn(
              'my-3 border-t',
              inverted ? 'border-primary-foreground/30' : plan ? 'border-amber-300/70' : 'border-border',
            )}
          />
        ),
        table: ({ children }) => (
          <div className="my-2 overflow-auto">
            <table className="w-full border-collapse text-xs">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className="border px-2 py-1 text-left font-medium">{children}</th>,
        td: ({ children }) => <td className="border px-2 py-1 align-top">{children}</td>,
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

function markdownFilePathFromHref(href: string | undefined) {
  let value = href?.trim() ?? ''
  if (!value || value.startsWith('#')) {
    return ''
  }

  if (value.startsWith('file://')) {
    value = value.slice('file://'.length)
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    try {
      const url = new URL(value)
      if (url.origin !== window.location.origin) {
        return ''
      }
      value = `${url.pathname}${url.search}${url.hash}`
    } catch {
      return ''
    }
  }

  try {
    value = decodeURI(value)
  } catch {
    // Keep the original href if it is not valid URI-encoded text.
  }

  value =
    value
      .split('#')[0]
      ?.split('?')[0]
      ?.replaceAll('\\', '/')
      .replace(/:\d+(?::\d+)?$/, '') ?? ''
  if (!value || value.endsWith('/')) {
    return ''
  }

  return looksLikeWorkspaceFileLink(value) ? value : ''
}

function looksLikeWorkspaceFileLink(path: string) {
  if (path.startsWith('./') || path.startsWith('../')) {
    return true
  }
  if (path.startsWith('/')) {
    return (
      ['/Users/', '/home/', '/repo/', '/workspace/', '/workspaces/', '/private/', '/tmp/', '/var/'].some((prefix) =>
        path.startsWith(prefix),
      ) && looksLikeFileName(path)
    )
  }
  return looksLikeFileName(path)
}

function looksLikeFileName(path: string) {
  const name = path.split('/').at(-1) ?? ''
  return (
    /^(AGENTS\.md|README(?:\.[\w-]+)?|Makefile|Dockerfile|go\.mod|go\.sum|package\.json|pnpm-lock\.yaml|yarn\.lock|\.env(?:\.[\w-]+)?)$/i.test(
      name,
    ) || /\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(name)
  )
}

function CodeBlock({
  code,
  className,
  variant,
  children,
}: {
  code: string
  className?: string
  variant: MarkdownVariant
  children: ReactNode
}) {
  return (
    <div className="group/code relative my-2">
      <FloatingCopyButton label="Copy code" value={code} variant={variant} />
      <pre className="overflow-auto rounded-md">
        <code
          className={cn(
            'block min-w-full whitespace-pre border p-3 pr-12 font-mono text-xs',
            variant === 'inverted'
              ? 'border-primary-foreground/20 bg-primary-foreground/15'
              : variant === 'plan'
                ? 'border-amber-300/70 bg-amber-100/80 text-amber-950 dark:border-amber-300/35 dark:bg-amber-300/12 dark:text-amber-50'
                : 'border-transparent bg-muted',
            className,
          )}
        >
          {children}
        </code>
      </pre>
    </div>
  )
}

function FloatingCopyButton({
  label,
  value,
  variant = 'default',
}: {
  label: string
  value: string
  variant?: MarkdownVariant
}) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  async function handleCopy() {
    setCopyFailed(false)
    try {
      await copyText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
      setCopyFailed(true)
    }
  }

  return (
    <>
      {copyFailed ? (
        <span
          role="alert"
          title={clipboardCopyErrorMessage}
          className="absolute right-12 top-2 z-10 whitespace-nowrap rounded-md border border-destructive/30 bg-background/95 px-2 py-1 text-[11px] font-medium text-destructive shadow-sm"
        >
          Copy failed
        </span>
      ) : null}
      <button
        type="button"
        aria-label={label}
        title={copyFailed ? clipboardCopyErrorMessage : label}
        onClick={() => void handleCopy()}
        className={cn(
          'absolute right-4 top-2 z-10 inline-flex size-7 items-center justify-center rounded-md border text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          variant === 'inverted'
            ? 'border-primary-foreground/20 bg-primary-foreground/12 text-primary-foreground hover:bg-primary-foreground/20'
            : variant === 'plan'
              ? 'border-amber-300/70 bg-amber-50/95 text-amber-800 hover:bg-amber-100 dark:border-amber-300/35 dark:bg-amber-950/80 dark:text-amber-100 dark:hover:bg-amber-900'
              : 'border-border/70 bg-background/90 text-muted-foreground hover:bg-background hover:text-foreground',
        )}
      >
        {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      </button>
    </>
  )
}

function childrenToString(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children)
  }
  if (Array.isArray(children)) {
    return children.map(childrenToString).join('')
  }
  if (isValidElement<{ children?: ReactNode }>(children)) {
    return childrenToString(children.props.children)
  }
  return ''
}

function ToolCallRow({
  tool,
  onOpenFilePath,
  focused = false,
}: {
  tool: ChatTranscriptTool
  onOpenFilePath?: (path: string) => Promise<void> | void
  focused?: boolean
}) {
  const output = tool.error || tool.text
  const hasDetails = Boolean(output || tool.content.length > 0)
  const [outputOpen, setOutputOpen] = useState(false)
  const name = tool.label.replace(/^Tool:\s*/, '')
  const statusDotClassName = toolStatusDotClassName(tool)
  const filePath = tool.kind === 'file-change' ? (tool.paths[0] ?? '') : ''
  const showFileEditorAction = Boolean(onOpenFilePath && filePath && output && !tool.error && looksLikeDiff(output))

  useEffect(() => {
    if (focused && hasDetails) setOutputOpen(true)
  }, [focused, hasDetails])

  return (
    <div
      className={cn('rounded text-xs', focused && 'bg-primary/10 ring-2 ring-primary/45')}
      data-search-focused={focused || undefined}
    >
      <button
        type="button"
        className="relative z-10 flex h-5 w-full min-w-0 touch-manipulation items-center gap-1 rounded py-0.5 text-left font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
        aria-expanded={hasDetails ? outputOpen : undefined}
        aria-label={hasDetails ? `${outputOpen ? 'Collapse' : 'Expand'} ${name}` : name}
        disabled={!hasDetails}
        onClick={() => {
          if (hasDetails) {
            setOutputOpen((current) => !current)
          }
        }}
      >
        {hasDetails ? (
          outputOpen ? (
            <ChevronDown className="pointer-events-none size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="pointer-events-none size-3 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="pointer-events-none size-3 shrink-0" aria-hidden="true" />
        )}
        {statusDotClassName ? (
          <span
            className={cn('pointer-events-none mr-0.5 size-2 shrink-0 rounded-full', statusDotClassName)}
            aria-hidden="true"
          />
        ) : null}
        <span className="pointer-events-none min-w-0 flex-1 truncate font-medium">{name}</span>
      </button>
      {hasDetails ? (
        outputOpen ? (
          <div className="relative ml-5 mt-1">
            {output ? <FloatingCopyButton label="Copy tool output" value={output} /> : null}
            {showFileEditorAction ? <FloatingOpenFileButton path={filePath} onOpenFilePath={onOpenFilePath} /> : null}
            {output ? (
              <ToolOutput
                output={output}
                error={Boolean(tool.error)}
                diff={tool.kind === 'file-change'}
                actionPadding={showFileEditorAction}
              />
            ) : null}
            {tool.content.length > 0 ? (
              <ToolResultContent content={tool.content} className={output ? 'mt-2' : ''} />
            ) : null}
          </div>
        ) : null
      ) : null}
    </div>
  )
}

function ToolResultContent({ content, className }: { content: ChatTranscriptToolContent[]; className?: string }) {
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {content.map((item, index) => {
        if (item.kind === 'image') {
          return (
            <ImageAttachmentPreview
              key={`${item.kind}-${item.sourceURL}-${index}`}
              attachment={{
                name: item.name,
                mediaType: item.mediaType,
                dataURL: '',
                sourceURL: item.sourceURL,
                sizeBytes: 0,
              }}
            />
          )
        }
        if (item.kind === 'audio') {
          return (
            <div
              key={`${item.kind}-${item.sourceURL}-${index}`}
              className="min-w-0 max-w-full rounded border border-border/60 bg-surface-muted/70 p-2"
            >
              <p className="mb-1 truncate font-medium text-muted-foreground">{item.name}</p>
              <audio controls preload="none" src={item.sourceURL} className="h-8 max-w-full" />
            </div>
          )
        }
        return <ToolResourceLink key={`${item.kind}-${item.uri}-${item.sourceURL}-${index}`} content={item} />
      })}
    </div>
  )
}

function ToolResourceLink({ content }: { content: ChatTranscriptToolContent }) {
  const externalURL = safeExternalURL(content.uri)
  const href = content.sourceURL || externalURL
  const download = content.sourceURL ? content.name : undefined
  const body = (
    <>
      <span className="block truncate font-medium text-foreground">{content.name}</span>
      {content.description ? <span className="block text-muted-foreground">{content.description}</span> : null}
      {content.mediaType || content.uri ? (
        <span className="block truncate font-mono text-[11px] text-muted-foreground/75">
          {[content.mediaType, content.uri].filter(Boolean).join(' · ')}
        </span>
      ) : null}
    </>
  )
  const className =
    'min-w-0 max-w-full rounded border border-border/60 bg-surface-muted/70 px-3 py-2 text-left transition-colors'

  if (!href) {
    return <div className={className}>{body}</div>
  }
  return (
    <a
      href={href}
      download={download}
      target={externalURL && !content.sourceURL ? '_blank' : undefined}
      rel={externalURL && !content.sourceURL ? 'noreferrer' : undefined}
      className={cn(className, 'hover:border-border hover:bg-surface-muted')}
    >
      {body}
    </a>
  )
}

function safeExternalURL(value: string) {
  if (!value) {
    return ''
  }
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : ''
  } catch {
    return ''
  }
}

function FloatingOpenFileButton({
  path,
  onOpenFilePath,
}: {
  path: string
  onOpenFilePath?: (path: string) => Promise<void> | void
}) {
  return (
    <button
      type="button"
      aria-label="Show in File Editor"
      onClick={() => void onOpenFilePath?.(path)}
      className="absolute right-10 top-2 z-10 inline-flex size-7 items-center justify-center rounded-md border border-border/70 bg-background/90 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <FileText className="size-3.5" aria-hidden="true" />
    </button>
  )
}

function ToolOutput({
  output,
  error,
  diff,
  actionPadding = false,
}: {
  output: string
  error: boolean
  diff: boolean
  actionPadding?: boolean
}) {
  if (!diff || error || !looksLikeDiff(output)) {
    return (
      <pre
        className={cn(
          'max-h-44 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-surface-muted/70 p-2 font-mono leading-relaxed text-muted-foreground',
          actionPadding ? 'pr-20' : 'pr-12',
          error && 'text-destructive',
        )}
      >
        {output}
      </pre>
    )
  }

  return (
    <pre
      className={cn(
        'max-h-64 overflow-auto rounded border border-border/60 bg-surface-muted/70 p-2 font-mono leading-relaxed text-muted-foreground',
        actionPadding ? 'pr-20' : 'pr-12',
      )}
    >
      {output.split('\n').map((line, index) => (
        <span
          key={`${index}-${line}`}
          className={cn('block min-h-[1.25em] min-w-full w-max whitespace-pre', diffLineClassName(line))}
        >
          {line || ' '}
        </span>
      ))}
    </pre>
  )
}

function looksLikeDiff(output: string) {
  return output
    .split('\n')
    .some(
      (line) =>
        line.startsWith('@@') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('-') ||
        line.startsWith('+'),
    )
}

function diffLineClassName(line: string) {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return 'bg-destructive/10 text-destructive'
  }
  if (line.startsWith('@@')) {
    return 'bg-primary/10 text-primary'
  }
  return ''
}

function DebugEventRow({ event }: { event: ChatDebugEvent }) {
  const [open, setOpen] = useState(false)
  const sequence = event.startSeq === event.endSeq ? `#${event.startSeq}` : `#${event.startSeq}-${event.endSeq}`
  const payload = JSON.stringify(event.payload, null, 2)

  return (
    <article className="flex justify-start">
      <div className="max-w-full sm:max-w-[min(48rem,90%)] border-l border-border/70 pl-3 text-xs">
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-1 rounded py-0.5 text-left font-mono text-muted-foreground/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${event.label}`}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">{event.label}</span>
          <span className="shrink-0 text-[11px] capitalize text-muted-foreground/70">{event.status}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/55">{sequence}</span>
          {event.eventCount > 1 ? (
            <span className="shrink-0 text-[11px] text-muted-foreground/55">{event.eventCount} events</span>
          ) : null}
        </button>
        {event.text || event.error ? (
          <p
            className={cn(
              'ml-5 mt-0.5 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground/70',
              event.error && 'text-destructive/85',
            )}
          >
            {event.error || event.text}
          </p>
        ) : null}
        {open ? (
          <div className="relative ml-5 mt-1">
            <FloatingCopyButton label="Copy debug payload" value={payload} />
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-surface-muted/70 p-2 pr-12 font-mono leading-relaxed text-muted-foreground">
              {payload}
            </pre>
          </div>
        ) : null}
      </div>
    </article>
  )
}

function RunErrorRow({ error }: { error: ChatRunError }) {
  const sequence = error.startSeq === error.endSeq ? `#${error.startSeq}` : `#${error.startSeq}-${error.endSeq}`
  const timestamp = formatMessageTimestamp(error.createdAt, true)

  return (
    <article className="flex justify-start" role="alert" aria-label={`${error.label}: ${error.error}`}>
      <div className="relative max-w-full sm:max-w-[min(48rem,90%)] rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 pr-12 text-sm text-destructive shadow-sm">
        <FloatingCopyButton label="Copy error" value={error.error} />
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
          <span className="min-w-0 flex-1 truncate">{error.label}</span>
          <span className="shrink-0 text-[11px] capitalize text-destructive/75">{error.status}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-destructive/65">{sequence}</span>
          {timestamp ? (
            <time
              className="hidden shrink-0 text-[11px] font-normal tabular-nums text-destructive/65 sm:inline"
              dateTime={error.createdAt}
            >
              {timestamp}
            </time>
          ) : null}
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-destructive">
          {error.error}
        </p>
      </div>
    </article>
  )
}

function toolStatusDotClassName(tool: ChatTranscriptTool) {
  if (tool.error || tool.status === 'failed') return 'bg-destructive'
  if (tool.status !== 'completed') return 'tool-activity-dot'
  return ''
}
