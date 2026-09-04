import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvent, EventHistoryResponse } from '@/lib/api'
import {
  defaultEventTurnPageSize,
  eventStreamURL,
  listEventTurnsAfter,
  listEventTurnsAround,
  listEventTurnsBefore,
  listRecentEventTurns,
} from '@/lib/api'
import { appendEvents, isTerminalEvent, isTransientEvent, knownEventTypes, lastSeq } from '@/lib/events'
import {
  appendBoundedEvent,
  boundEventWindow,
  cachedEventWindowPolicy,
  eventWindowStats,
  liveEventWindowPolicy,
  mergeBoundedEvents,
  residentEventWindowPolicy,
} from '@/lib/session-event-window'
import {
  clearSessionCacheForTest,
  ensurePersistentSessionStorage,
  readCachedSessionEvents as readPersistentCachedSessionEvents,
  readCachedSessionEventsBefore as readPersistentCachedSessionEventsBefore,
  writeCachedSessionEvent as writePersistentCachedSessionEvent,
  writeCachedSessionEventPage as writePersistentCachedSessionEventPage,
  writeCachedSessionEventWindow as writePersistentCachedSessionEventWindow,
} from '@/lib/session-cache'

export type StreamState = 'idle' | 'loading' | 'connected' | 'reconnecting' | 'disconnected'

type Options = {
  onEvent?: (event: AgentEvent) => void
  reconnectDelayMs?: number
  refreshKey?: number
  includeDebugEvents?: boolean
  targetSeq?: number
}

type SessionEventCacheEntry = {
  events: AgentEvent[]
  lastSeq: number
  oldestSeq: number
  hasOlderEvents: boolean
  hasNewerEvents: boolean
  usedAt: number
}

const recentEventsRequestRetentionMs = 2000
const streamResyncEventType = 'stream.resync.required'
const maximumReconnectDelayMs = 15_000
export const initialEventHistoryByteBudget = 2 * 1024 * 1024
export const initialEventHistoryMaxTurns = 50
const pagedEventHistoryByteBudget = 1024 * 1024
const pagedEventHistoryTurns = 25
const persistentHotWindowCheckpointSeqs = 250
const memoryEventCacheBytesLimit = 32 * 1024 * 1024
const memoryEventCacheEntryLimit = 50
const sessionEventCache = new Map<string, SessionEventCacheEntry>()
const recentEventsRequests = new Map<string, Promise<EventHistoryResponse>>()

export function clearSessionEventCacheForTest() {
  sessionEventCache.clear()
  recentEventsRequests.clear()
  clearSessionCacheForTest()
}

export function useSessionEvents(sessionID: string | null, options: Options = {}) {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [liveEvents, setLiveEvents] = useState<AgentEvent[]>([])
  const [streamState, setStreamState] = useState<StreamState>('idle')
  const [streamSessionID, setStreamSessionID] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [hasOlderEvents, setHasOlderEvents] = useState(false)
  const [hasNewerEvents, setHasNewerEventsState] = useState(false)
  const [loadingOlderEvents, setLoadingOlderEvents] = useState(false)
  const [loadingNewerEvents, setLoadingNewerEvents] = useState(false)
  const lastSeqRef = useRef(0)
  const lastDurableSeqRef = useRef(0)
  const oldestSeqRef = useRef(0)
  const newestSeqRef = useRef(0)
  const activeSessionIDRef = useRef<string | null>(null)
  const selectedSessionIDRef = useRef<string | null>(null)
  const selectionEpochRef = useRef(0)
  const loadedSessionIDRef = useRef<string | null>(null)
  const loadedIncludeDebugEventsRef = useRef(false)
  const loadingOlderEventsRef = useRef(false)
  const loadingNewerEventsRef = useRef(false)
  const followingTailRef = useRef(true)
  const hasNewerEventsRef = useRef(false)
  const liveEventsRef = useRef<AgentEvent[]>([])
  const persistentHotWindowSeqRef = useRef(0)
  const onEventRef = useRef(options.onEvent)
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000
  const refreshKey = options.refreshKey ?? 0
  const includeDebugEvents = options.includeDebugEvents ?? false
  const targetSeq = options.targetSeq ?? 0
  const effectiveStreamState: StreamState =
    sessionID !== streamSessionID ? (sessionID ? 'loading' : 'idle') : streamState

  const setHasNewerEvents = useCallback((value: boolean) => {
    hasNewerEventsRef.current = value
    setHasNewerEventsState(value)
  }, [])

  useEffect(() => {
    onEventRef.current = options.onEvent
  }, [options.onEvent])

  useEffect(() => {
    const sameSessionRefresh =
      selectedSessionIDRef.current === sessionID &&
      loadedSessionIDRef.current === sessionID &&
      loadedIncludeDebugEventsRef.current === includeDebugEvents
    const cachedSession =
      sessionID && !sameSessionRefresh ? readCachedSessionEvents(sessionID, includeDebugEvents) : null
    if (selectedSessionIDRef.current !== sessionID) selectionEpochRef.current += 1
    const selectionEpoch = selectionEpochRef.current
    selectedSessionIDRef.current = sessionID
    activeSessionIDRef.current = sessionID
    setStreamSessionID(sessionID)
    loadingOlderEventsRef.current = false
    loadingNewerEventsRef.current = false
    followingTailRef.current = true
    setError('')
    setLoadingOlderEvents(false)
    setLoadingNewerEvents(false)

    if (!sessionID) {
      lastSeqRef.current = 0
      lastDurableSeqRef.current = 0
      oldestSeqRef.current = 0
      newestSeqRef.current = 0
      liveEventsRef.current = []
      persistentHotWindowSeqRef.current = 0
      loadedSessionIDRef.current = null
      selectedSessionIDRef.current = null
      loadedIncludeDebugEventsRef.current = false
      setEvents([])
      setLiveEvents([])
      setHasOlderEvents(false)
      setHasNewerEvents(false)
      setStreamState('idle')
      return
    }

    if (!sameSessionRefresh) {
      if (cachedSession) {
        lastSeqRef.current = cachedSession.lastSeq
        lastDurableSeqRef.current = cachedSession.lastSeq
        oldestSeqRef.current = cachedSession.oldestSeq
        newestSeqRef.current = lastSeq(cachedSession.events)
        liveEventsRef.current = cachedSession.events
        persistentHotWindowSeqRef.current = 0
        loadedSessionIDRef.current = sessionID
        loadedIncludeDebugEventsRef.current = includeDebugEvents
        setEvents(cachedSession.events)
        setLiveEvents(cachedSession.events)
        setHasOlderEvents(cachedSession.hasOlderEvents)
        setHasNewerEvents(cachedSession.hasNewerEvents)
      } else {
        lastSeqRef.current = 0
        lastDurableSeqRef.current = 0
        oldestSeqRef.current = 0
        newestSeqRef.current = 0
        liveEventsRef.current = []
        persistentHotWindowSeqRef.current = 0
        setEvents([])
        setLiveEvents([])
        setHasOlderEvents(false)
        setHasNewerEvents(false)
      }
    }

    const activeSessionID = sessionID
    const activeIncludeDebugEvents = includeDebugEvents
    if (!activeIncludeDebugEvents) void ensurePersistentSessionStorage()
    let closed = false
    let source: EventSource | null = null
    let reconnectTimer: number | undefined
    let reconnectAttempt = 0
    let loadingTail = false

    function closeSource() {
      source?.close()
      source = null
    }

    function scheduleReconnect() {
      if (closed || reconnectTimer !== undefined) return
      setStreamState('reconnecting')
      closeSource()
      const delay = Math.min(reconnectDelayMs * 2 ** reconnectAttempt, maximumReconnectDelayMs)
      reconnectAttempt += 1
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined
        connect(lastSeqRef.current)
      }, delay)
    }

    function handleEvent(message: MessageEvent<string>) {
      try {
        const event = JSON.parse(message.data) as AgentEvent
        lastSeqRef.current = Math.max(lastSeqRef.current, event.seq)
        if (!isTransientEvent(event)) {
          lastDurableSeqRef.current = Math.max(lastDurableSeqRef.current, event.seq)
        }

        const nextLive = appendBoundedEvent(liveEventsRef.current, event, liveEventWindowPolicy)
        liveEventsRef.current = nextLive.events
        setLiveEvents(nextLive.events)

        if (followingTailRef.current) {
          setEvents((current) => {
            const next = appendBoundedEvent(current, event, residentEventWindowPolicy)
            oldestSeqRef.current = firstSeq(next.events)
            newestSeqRef.current = lastSeq(next.events)
            setHasOlderEvents((currentHasOlder) => currentHasOlder || next.trimmedStart || oldestSeqRef.current > 1)
            setHasNewerEvents(false)
            return next.events
          })
        } else if (!isTransientEvent(event)) {
          setHasNewerEvents(true)
        }

        writeCachedSessionEvents(
          activeSessionID,
          nextLive.events,
          nextLive.trimmedStart || firstSeq(nextLive.events) > 1,
          false,
          activeIncludeDebugEvents,
          lastDurableSeqRef.current,
        )
        if (!activeIncludeDebugEvents && !isTransientEvent(event)) {
          void writePersistentCachedSessionEvent(activeSessionID, event, lastDurableSeqRef.current)
          if (
            isTerminalEvent(event.type) ||
            lastDurableSeqRef.current - persistentHotWindowSeqRef.current >= persistentHotWindowCheckpointSeqs
          ) {
            persistentHotWindowSeqRef.current = lastDurableSeqRef.current
            void writePersistentCachedSessionEventWindow(
              activeSessionID,
              nextLive.events,
              nextLive.trimmedStart || firstSeq(nextLive.events) > 1,
              lastDurableSeqRef.current,
            )
          }
        }
        onEventRef.current?.(event)
      } catch (eventError) {
        setError(eventError instanceof Error ? eventError.message : 'Failed to parse event')
      }
    }

    function connect(afterSeq: number) {
      if (closed) return
      closeSource()
      source = new EventSource(
        eventStreamURL(activeSessionID, afterSeq, {
          includeDebug: activeIncludeDebugEvents,
        }),
      )
      source.onopen = () => {
        if (!closed) {
          reconnectAttempt = 0
          setStreamState('connected')
          setError('')
        }
      }
      source.onerror = () => {
        if (!closed) scheduleReconnect()
      }
      source.addEventListener(streamResyncEventType, () => {
        if (!closed) {
          closeSource()
          void loadTail(true, true)
        }
      })
      for (const eventType of knownEventTypes) {
        source.addEventListener(eventType, handleEvent)
      }
    }

    function applyTail(history: EventHistoryResponse, preserveVisible: boolean) {
      const historyLastSeq = lastSeq(history.events)
      const normalizedHistoryEvents = appendEvents([], history.events)
      lastSeqRef.current = Math.max(lastSeqRef.current, history.page?.server_last_seq ?? 0, historyLastSeq)
      lastDurableSeqRef.current = Math.max(
        lastDurableSeqRef.current,
        history.page?.server_last_seq ?? 0,
        lastDurableSeq(normalizedHistoryEvents),
      )
      const boundedLive = boundEventWindow(normalizedHistoryEvents, 'latest', liveEventWindowPolicy)
      liveEventsRef.current = boundedLive.events
      setLiveEvents(boundedLive.events)

      const pageHasOlder = history.page?.has_older ?? firstSeq(history.events) > 1
      if (!followingTailRef.current) {
        setHasNewerEvents(true)
      } else {
        setEvents((current) => {
          const next = preserveVisible
            ? mergeBoundedEvents(current, normalizedHistoryEvents, 'latest', residentEventWindowPolicy)
            : boundEventWindow(normalizedHistoryEvents, 'latest', residentEventWindowPolicy)
          oldestSeqRef.current = firstSeq(next.events)
          newestSeqRef.current = lastSeq(next.events)
          setHasOlderEvents(pageHasOlder || next.trimmedStart)
          setHasNewerEvents(history.page?.has_newer ?? false)
          return next.events
        })
      }

      loadedSessionIDRef.current = activeSessionID
      loadedIncludeDebugEventsRef.current = activeIncludeDebugEvents
      writeCachedSessionEvents(
        activeSessionID,
        boundedLive.events,
        pageHasOlder || boundedLive.trimmedStart,
        history.page?.has_newer ?? false,
        activeIncludeDebugEvents,
        lastDurableSeqRef.current,
      )
      if (!activeIncludeDebugEvents) {
        persistentHotWindowSeqRef.current = lastDurableSeqRef.current
        void writePersistentCachedSessionEventPage(activeSessionID, normalizedHistoryEvents, {
          coverageFirstSeq:
            history.page === undefined
              ? firstSeq(normalizedHistoryEvents)
              : history.page.first_seq ||
                (history.events.length === 0 && history.page.server_last_seq ? 1 : 0),
          coverageLastSeq: history.page?.server_last_seq ?? history.page?.last_seq ?? historyLastSeq,
          serverLastSeq: history.page?.server_last_seq ?? lastDurableSeqRef.current,
          hasOlderEvents: pageHasOlder,
        })
      }
    }

    async function loadTail(preserveVisible: boolean, force = false) {
      if (closed || loadingTail) return
      loadingTail = true
      if (!preserveVisible) setStreamState('loading')
      try {
        const history = await listRecentEventsOnce(
          activeSessionID,
          refreshKey,
          activeIncludeDebugEvents,
          selectionEpoch,
          force,
        )
        if (closed) return
        applyTail(history, preserveVisible)
        connect(lastSeqRef.current)
      } catch (loadError) {
        if (closed) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load events')
        setStreamState('disconnected')
      } finally {
        loadingTail = false
      }
    }

    async function loadTarget() {
      setStreamState('loading')
      followingTailRef.current = false
      try {
        const [history, tail] = await Promise.all([
          listEventTurnsAround(activeSessionID, targetSeq, 2, {
            includeDebug: activeIncludeDebugEvents,
            maxBytes: pagedEventHistoryByteBudget,
          }),
          listAdaptiveRecentEventTurns(activeSessionID, activeIncludeDebugEvents),
        ])
        if (closed) return

        const visible = boundEventWindow(appendEvents([], history.events), 'latest', residentEventWindowPolicy)
        const boundedLive = boundEventWindow(appendEvents([], tail.events), 'latest', liveEventWindowPolicy)
        liveEventsRef.current = boundedLive.events
        setLiveEvents(boundedLive.events)
        setEvents(visible.events)
        oldestSeqRef.current = firstSeq(visible.events)
        newestSeqRef.current = lastSeq(visible.events)
        lastSeqRef.current = Math.max(
          lastSeqRef.current,
          tail.page?.server_last_seq ?? 0,
          lastSeq(tail.events),
          newestSeqRef.current,
        )
        lastDurableSeqRef.current = Math.max(
          lastDurableSeqRef.current,
          tail.page?.server_last_seq ?? 0,
          lastDurableSeq(tail.events),
          lastDurableSeq(history.events),
        )
        setHasOlderEvents((history.page?.has_older ?? oldestSeqRef.current > 1) || visible.trimmedStart)
        setHasNewerEvents((history.page?.has_newer ?? false) || visible.trimmedEnd)
        loadedSessionIDRef.current = activeSessionID
        loadedIncludeDebugEventsRef.current = activeIncludeDebugEvents
        writeCachedSessionEvents(
          activeSessionID,
          boundedLive.events,
          (tail.page?.has_older ?? firstSeq(tail.events) > 1) || boundedLive.trimmedStart,
          false,
          activeIncludeDebugEvents,
          lastDurableSeqRef.current,
        )
        if (!activeIncludeDebugEvents) {
          persistentHotWindowSeqRef.current = lastDurableSeqRef.current
          void writePersistentCachedSessionEventWindow(
            activeSessionID,
            boundedLive.events,
            (tail.page?.has_older ?? firstSeq(tail.events) > 1) || boundedLive.trimmedStart,
            lastDurableSeqRef.current,
          )
          void writePersistentCachedSessionEventPage(activeSessionID, history.events, {
            coverageFirstSeq: history.page?.first_seq ?? firstSeq(history.events),
            coverageLastSeq: history.page?.last_seq ?? lastSeq(history.events),
            serverLastSeq: tail.page?.server_last_seq ?? lastDurableSeqRef.current,
            hasOlderEvents: history.page?.has_older,
            updateHotWindow: false,
          })
          void writePersistentCachedSessionEventPage(activeSessionID, tail.events, {
            coverageFirstSeq: tail.page?.first_seq ?? firstSeq(tail.events),
            coverageLastSeq: tail.page?.server_last_seq ?? tail.page?.last_seq ?? lastSeq(tail.events),
            serverLastSeq: tail.page?.server_last_seq ?? lastDurableSeqRef.current,
            hasOlderEvents: tail.page?.has_older,
            updateHotWindow: false,
          })
        }
        connect(lastSeqRef.current)
      } catch (loadError) {
        if (closed) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load the selected event')
        setStreamState('disconnected')
      }
    }

    async function hydratePersistentCacheOrLoad() {
      setStreamState('loading')
      const persistentSession = await readPersistentCachedSessionEvents(
        activeSessionID,
        activeIncludeDebugEvents,
      )
      if (closed) return
      if (persistentSession) {
        const bounded = boundEventWindow(persistentSession.events, 'latest', cachedEventWindowPolicy)
        lastSeqRef.current = persistentSession.lastSeq
        lastDurableSeqRef.current = persistentSession.lastSeq
        oldestSeqRef.current = firstSeq(bounded.events)
        newestSeqRef.current = lastSeq(bounded.events)
        liveEventsRef.current = bounded.events
        persistentHotWindowSeqRef.current = persistentSession.lastSeq
        loadedSessionIDRef.current = activeSessionID
        loadedIncludeDebugEventsRef.current = activeIncludeDebugEvents
        setEvents(bounded.events)
        setLiveEvents(bounded.events)
        setHasOlderEvents(persistentSession.hasOlderEvents || bounded.trimmedStart)
        setHasNewerEvents(false)
        connect(lastSeqRef.current)
        return
      }
      await loadTail(false)
    }

    if (targetSeq > 0) {
      void loadTarget()
    } else if (sameSessionRefresh) {
      void loadTail(true)
    } else if (cachedSession) {
      connect(lastSeqRef.current)
    } else {
      void hydratePersistentCacheOrLoad()
    }

    return () => {
      closed = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      closeSource()
      if (
        !activeIncludeDebugEvents &&
        liveEventsRef.current.length > 0 &&
        lastDurableSeqRef.current > persistentHotWindowSeqRef.current
      ) {
        persistentHotWindowSeqRef.current = lastDurableSeqRef.current
        void writePersistentCachedSessionEventWindow(
          activeSessionID,
          liveEventsRef.current,
          firstSeq(liveEventsRef.current) > 1,
          lastDurableSeqRef.current,
        )
      }
      if (activeSessionIDRef.current === activeSessionID) activeSessionIDRef.current = null
      setStreamState('disconnected')
    }
  }, [includeDebugEvents, reconnectDelayMs, refreshKey, sessionID, setHasNewerEvents, targetSeq])

  const loadOlderEvents = useCallback(async () => {
    if (!sessionID || loadingOlderEventsRef.current) return
    const beforeSeq = oldestSeqRef.current
    if (beforeSeq <= 1) {
      setHasOlderEvents(false)
      return
    }

    loadingOlderEventsRef.current = true
    followingTailRef.current = false
    setLoadingOlderEvents(true)
    setError('')
    try {
      const persistentHistory = await readPersistentCachedSessionEventsBefore(
        sessionID,
        beforeSeq,
        pagedEventHistoryTurns,
        pagedEventHistoryByteBudget,
        includeDebugEvents,
      )
      const history = persistentHistory
        ? {
            events: persistentHistory.events,
            page: {
              first_seq: persistentHistory.oldestSeq,
              last_seq: lastSeq(persistentHistory.events),
              server_last_seq: persistentHistory.lastSeq,
              has_older: persistentHistory.hasOlderEvents,
              has_newer: true,
              starts_mid_turn: false,
              ends_mid_turn: true,
            },
          }
        : await listEventTurnsBefore(sessionID, beforeSeq, pagedEventHistoryTurns, {
            includeDebug: includeDebugEvents,
            maxBytes: pagedEventHistoryByteBudget,
          })
      if (activeSessionIDRef.current !== sessionID) return
      if (history.events.length === 0) {
        setHasOlderEvents(false)
        return
      }
      lastDurableSeqRef.current = Math.max(
        lastDurableSeqRef.current,
        history.page?.server_last_seq ?? 0,
        lastDurableSeq(history.events),
      )
      setEvents((current) => {
        const next = mergeBoundedEvents(current, history.events, 'oldest', residentEventWindowPolicy)
        oldestSeqRef.current = firstSeq(next.events)
        newestSeqRef.current = lastSeq(next.events)
        setHasOlderEvents((history.page?.has_older ?? oldestSeqRef.current > 1) || next.trimmedStart)
        setHasNewerEvents(hasNewerEventsRef.current || next.trimmedEnd)
        return next.events
      })
      if (!persistentHistory && !includeDebugEvents) {
        void writePersistentCachedSessionEventPage(sessionID, history.events, {
          coverageFirstSeq: history.page?.first_seq ?? firstSeq(history.events),
          coverageLastSeq: beforeSeq - 1,
          serverLastSeq: history.page?.server_last_seq ?? lastDurableSeqRef.current,
          hasOlderEvents: history.page?.has_older,
        })
      }
    } catch (loadError) {
      if (activeSessionIDRef.current === sessionID) {
        setError(loadError instanceof Error ? loadError.message : 'Failed to load older events')
      }
    } finally {
      if (activeSessionIDRef.current === sessionID) {
        loadingOlderEventsRef.current = false
        setLoadingOlderEvents(false)
      }
    }
  }, [includeDebugEvents, sessionID, setHasNewerEvents])

  const loadNewerEvents = useCallback(async () => {
    if (!sessionID || loadingNewerEventsRef.current) return
    const afterSeq = newestSeqRef.current
    loadingNewerEventsRef.current = true
    setLoadingNewerEvents(true)
    setError('')
    try {
      const history = await listEventTurnsAfter(sessionID, afterSeq, pagedEventHistoryTurns, {
        includeDebug: includeDebugEvents,
        maxBytes: pagedEventHistoryByteBudget,
      })
      if (activeSessionIDRef.current !== sessionID) return
      if (history.events.length === 0) {
        setHasNewerEvents(false)
        followingTailRef.current = true
        return
      }
      lastDurableSeqRef.current = Math.max(
        lastDurableSeqRef.current,
        history.page?.server_last_seq ?? 0,
        lastDurableSeq(history.events),
      )
      setEvents((current) => {
        const next = mergeBoundedEvents(current, history.events, 'latest', residentEventWindowPolicy)
        oldestSeqRef.current = firstSeq(next.events)
        newestSeqRef.current = lastSeq(next.events)
        const hasNewer = history.page?.has_newer ?? false
        setHasOlderEvents((currentHasOlder) => currentHasOlder || next.trimmedStart || oldestSeqRef.current > 1)
        setHasNewerEvents(hasNewer || next.trimmedEnd)
        followingTailRef.current = !(hasNewer || next.trimmedEnd)
        return next.events
      })
      if (!includeDebugEvents) {
        void writePersistentCachedSessionEventPage(sessionID, history.events, {
          coverageFirstSeq: history.page?.first_seq ?? afterSeq + 1,
          coverageLastSeq: history.page?.last_seq ?? lastSeq(history.events),
          serverLastSeq: history.page?.server_last_seq ?? lastDurableSeqRef.current,
          hasOlderEvents: history.page?.has_older,
        })
      }
    } catch (loadError) {
      if (activeSessionIDRef.current === sessionID) {
        setError(loadError instanceof Error ? loadError.message : 'Failed to load newer events')
      }
    } finally {
      if (activeSessionIDRef.current === sessionID) {
        loadingNewerEventsRef.current = false
        setLoadingNewerEvents(false)
      }
    }
  }, [includeDebugEvents, sessionID, setHasNewerEvents])

  const jumpToLatest = useCallback(async () => {
    if (!sessionID) return
    setError('')
    followingTailRef.current = true
    setEvents((current) => {
      const immediate = mergeBoundedEvents(current, liveEventsRef.current, 'latest', residentEventWindowPolicy)
      oldestSeqRef.current = firstSeq(immediate.events)
      newestSeqRef.current = lastSeq(immediate.events)
      setHasOlderEvents((currentHasOlder) => currentHasOlder || immediate.trimmedStart || oldestSeqRef.current > 1)
      return immediate.events
    })
    setHasNewerEvents(false)

    try {
      const history = await listAdaptiveRecentEventTurns(sessionID, includeDebugEvents)
      if (activeSessionIDRef.current !== sessionID) return
      const combined = appendEvents([], [...history.events, ...liveEventsRef.current])
      lastDurableSeqRef.current = Math.max(
        lastDurableSeqRef.current,
        history.page?.server_last_seq ?? 0,
        lastDurableSeq(history.events),
      )
      setEvents((current) => {
        const next = mergeBoundedEvents(current, combined, 'latest', residentEventWindowPolicy)
        oldestSeqRef.current = firstSeq(next.events)
        newestSeqRef.current = lastSeq(next.events)
        lastSeqRef.current = Math.max(lastSeqRef.current, newestSeqRef.current)
        setHasOlderEvents((history.page?.has_older ?? oldestSeqRef.current > 1) || next.trimmedStart)
        return next.events
      })
      if (!includeDebugEvents) {
        void writePersistentCachedSessionEventPage(sessionID, history.events, {
          coverageFirstSeq: history.page?.first_seq ?? firstSeq(history.events),
          coverageLastSeq: history.page?.last_seq ?? lastSeq(history.events),
          serverLastSeq: history.page?.server_last_seq ?? lastDurableSeqRef.current,
          hasOlderEvents: history.page?.has_older,
        })
      }
    } catch (loadError) {
      if (activeSessionIDRef.current === sessionID) {
        setError(loadError instanceof Error ? loadError.message : 'Failed to refresh the latest events')
      }
    }
  }, [includeDebugEvents, sessionID, setHasNewerEvents])

  const setFollowingTail = useCallback((following: boolean) => {
    if (!following) {
      followingTailRef.current = false
    } else if (!hasNewerEventsRef.current) {
      followingTailRef.current = true
    }
  }, [])

  return {
    events,
    liveEvents,
    streamState: effectiveStreamState,
    error,
    hasOlderEvents,
    hasNewerEvents,
    loadingOlderEvents,
    loadingNewerEvents,
    loadOlderEvents,
    loadNewerEvents,
    jumpToLatest,
    setFollowingTail,
  }
}

function firstSeq(events: AgentEvent[]) {
  return events.reduce((min, event) => (min === 0 ? event.seq : Math.min(min, event.seq)), 0)
}

function listRecentEventsOnce(
  sessionID: string,
  refreshKey: number,
  includeDebugEvents: boolean,
  selectionEpoch: number,
  force = false,
) {
  const key = `${sessionID}:${refreshKey}:${includeDebugEvents ? 'debug' : 'normal'}:${selectionEpoch}`
  if (force) recentEventsRequests.delete(key)
  const existing = recentEventsRequests.get(key)
  if (existing) return existing

  const request = listAdaptiveRecentEventTurns(sessionID, includeDebugEvents).catch((error) => {
    recentEventsRequests.delete(key)
    throw error
  })
  recentEventsRequests.set(key, request)
  request.then(
    () => {
      window.setTimeout(() => {
        if (recentEventsRequests.get(key) === request) recentEventsRequests.delete(key)
      }, recentEventsRequestRetentionMs)
    },
    () => undefined,
  )
  return request
}

function readCachedSessionEvents(sessionID: string, includeDebugEvents: boolean): SessionEventCacheEntry | null {
  const cacheKey = sessionEventCacheKey(sessionID, includeDebugEvents)
  const entry = sessionEventCache.get(cacheKey)
  if (!entry) return null
  const next = { ...entry, usedAt: Date.now() }
  sessionEventCache.set(cacheKey, next)
  return next
}

function writeCachedSessionEvents(
  sessionID: string,
  events: AgentEvent[],
  hasOlderEvents: boolean,
  hasNewerEvents: boolean,
  includeDebugEvents: boolean,
  cursorSeq = lastSeq(events),
) {
  const cacheKey = sessionEventCacheKey(sessionID, includeDebugEvents)
  const cacheableEvents = events.filter((event) => !isTransientEvent(event))
  const bounded = boundEventWindow(cacheableEvents, 'latest', cachedEventWindowPolicy)
  const oldestSeq = firstSeq(bounded.events)
  sessionEventCache.set(cacheKey, {
    events: bounded.events,
    lastSeq: Math.max(cursorSeq, lastSeq(bounded.events)),
    oldestSeq,
    hasOlderEvents: hasOlderEvents || bounded.trimmedStart,
    hasNewerEvents,
    usedAt: Date.now(),
  })
  evictOldSessionEventCaches()
}

function lastDurableSeq(events: AgentEvent[]) {
  return events.reduce(
    (max, event) => (isTransientEvent(event) ? max : Math.max(max, event.seq)),
    0,
  )
}

function sessionEventCacheKey(sessionID: string, includeDebugEvents: boolean) {
  return `${sessionID}:${includeDebugEvents ? 'debug' : 'normal'}`
}

export function trimEventsToRecentTurns(events: AgentEvent[], turns: number) {
  if (turns <= 0) return []
  let foundTurns = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type !== 'user.message.completed') continue
    foundTurns += 1
    if (foundTurns === turns) return events.slice(index)
  }
  return events
}

export async function listAdaptiveRecentEventTurns(
  sessionID: string,
  includeDebugEvents = false,
  byteBudget = initialEventHistoryByteBudget,
  maxTurns = initialEventHistoryMaxTurns,
) {
  return listRecentEventTurns(sessionID, maxTurns, {
    includeDebug: includeDebugEvents,
    maxBytes: byteBudget,
  })
}

export function trimEventsToRecentTurnBudget(
  events: AgentEvent[],
  byteBudget: number,
  minimumTurns = defaultEventTurnPageSize,
  maximumTurns = initialEventHistoryMaxTurns,
  includePreamble = false,
) {
  if (events.length === 0 || byteBudget <= 0 || maximumTurns <= 0) return []

  const turnStarts = events.flatMap((event, index) => (event.type === 'user.message.completed' ? [index] : []))
  if (turnStarts.length === 0) return events

  let selectedTurns = 0
  let selectedBytes = 0
  let start = events.length
  for (let turnIndex = turnStarts.length - 1; turnIndex >= 0 && selectedTurns < maximumTurns; turnIndex -= 1) {
    const turnStart = turnStarts[turnIndex]
    const turnEnd = turnIndex + 1 < turnStarts.length ? turnStarts[turnIndex + 1] : events.length
    const turnBytes = serializedHistoryBytes(events.slice(turnStart, turnEnd))
    if (selectedTurns >= minimumTurns && selectedBytes + turnBytes > byteBudget) {
      break
    }
    start = turnStart
    selectedTurns += 1
    selectedBytes += turnBytes
  }

  if (includePreamble && start === turnStarts[0] && turnStarts[0] > 0) {
    const preambleBytes = serializedHistoryBytes(events.slice(0, turnStarts[0]))
    if (selectedBytes + preambleBytes <= byteBudget) {
      start = 0
    }
  }
  return events.slice(start)
}

function serializedHistoryBytes(events: AgentEvent[]) {
  const encoder = new TextEncoder()
  return events.reduce((bytes, event) => {
    try {
      return bytes + encoder.encode(JSON.stringify(event)).byteLength
    } catch {
      return Number.MAX_SAFE_INTEGER
    }
  }, 2)
}

function evictOldSessionEventCaches() {
  const entries = [...sessionEventCache.entries()].sort((left, right) => left[1].usedAt - right[1].usedAt)
  let totalBytes = entries.reduce((total, [, entry]) => total + eventWindowStats(entry.events).bytes, 0)
  for (const [sessionID, entry] of entries) {
    if (totalBytes <= memoryEventCacheBytesLimit && sessionEventCache.size <= memoryEventCacheEntryLimit) break
    sessionEventCache.delete(sessionID)
    totalBytes -= eventWindowStats(entry.events).bytes
  }
}
