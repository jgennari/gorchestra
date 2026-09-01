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
  liveEventWindowPolicy,
  mergeBoundedEvents,
  residentEventWindowPolicy,
} from '@/lib/session-event-window'
import {
  clearSessionCacheForTest,
  readCachedSessionEvents as readPersistentCachedSessionEvents,
  writeCachedSessionEvents as writePersistentCachedSessionEvents,
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

const cachedSessionLimit = 8
const recentEventsRequestRetentionMs = 2000
const persistentEventsWriteDelayMs = 1200
const streamResyncEventType = 'stream.resync.required'
const sessionEventCache = new Map<string, SessionEventCacheEntry>()
const recentEventsRequests = new Map<string, Promise<EventHistoryResponse>>()
const persistentEventsWriteTimers = new Map<string, number>()

export function clearSessionEventCacheForTest() {
  sessionEventCache.clear()
  recentEventsRequests.clear()
  for (const timer of persistentEventsWriteTimers.values()) {
    window.clearTimeout(timer)
  }
  persistentEventsWriteTimers.clear()
  clearSessionCacheForTest()
}

export function useSessionEvents(sessionID: string | null, options: Options = {}) {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [liveEvents, setLiveEvents] = useState<AgentEvent[]>([])
  const [streamState, setStreamState] = useState<StreamState>('idle')
  const [error, setError] = useState('')
  const [hasOlderEvents, setHasOlderEvents] = useState(false)
  const [hasNewerEvents, setHasNewerEventsState] = useState(false)
  const [loadingOlderEvents, setLoadingOlderEvents] = useState(false)
  const [loadingNewerEvents, setLoadingNewerEvents] = useState(false)
  const lastSeqRef = useRef(0)
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
  const onEventRef = useRef(options.onEvent)
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000
  const refreshKey = options.refreshKey ?? 0
  const includeDebugEvents = options.includeDebugEvents ?? false
  const targetSeq = options.targetSeq ?? 0

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
    loadingOlderEventsRef.current = false
    loadingNewerEventsRef.current = false
    followingTailRef.current = true
    setError('')
    setLoadingOlderEvents(false)
    setLoadingNewerEvents(false)

    if (!sessionID) {
      lastSeqRef.current = 0
      oldestSeqRef.current = 0
      newestSeqRef.current = 0
      liveEventsRef.current = []
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
        oldestSeqRef.current = cachedSession.oldestSeq
        newestSeqRef.current = lastSeq(cachedSession.events)
        liveEventsRef.current = cachedSession.events
        loadedSessionIDRef.current = sessionID
        loadedIncludeDebugEventsRef.current = includeDebugEvents
        setEvents(cachedSession.events)
        setLiveEvents(cachedSession.events)
        setHasOlderEvents(cachedSession.hasOlderEvents)
        setHasNewerEvents(cachedSession.hasNewerEvents)
      } else {
        lastSeqRef.current = 0
        oldestSeqRef.current = 0
        newestSeqRef.current = 0
        liveEventsRef.current = []
        setEvents([])
        setLiveEvents([])
        setHasOlderEvents(false)
        setHasNewerEvents(false)
      }
    }

    const activeSessionID = sessionID
    const activeIncludeDebugEvents = includeDebugEvents
    let closed = false
    let source: EventSource | null = null
    let reconnectTimer: number | undefined
    let loadingTail = false

    function closeSource() {
      source?.close()
      source = null
    }

    function scheduleReconnect() {
      if (closed || reconnectTimer !== undefined) return
      setStreamState('reconnecting')
      closeSource()
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined
        void loadTail(true)
      }, reconnectDelayMs)
    }

    function handleEvent(message: MessageEvent<string>) {
      try {
        const event = JSON.parse(message.data) as AgentEvent
        lastSeqRef.current = Math.max(lastSeqRef.current, event.seq)

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
          lastSeqRef.current,
          isTerminalEvent(event.type),
        )
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
          void loadTail(true)
        }
      })
      for (const eventType of knownEventTypes) {
        source.addEventListener(eventType, handleEvent)
      }
    }

    function applyTail(history: EventHistoryResponse, preserveVisible: boolean) {
      const historyLastSeq = lastSeq(history.events)
      const normalizedHistoryEvents = appendEvents([], history.events)
      lastSeqRef.current = Math.max(lastSeqRef.current, historyLastSeq)
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
        lastSeqRef.current,
        true,
      )
    }

    async function loadTail(preserveVisible: boolean) {
      if (closed || loadingTail) return
      loadingTail = true
      if (!preserveVisible) setStreamState('loading')
      try {
        const history = await listRecentEventsOnce(
          activeSessionID,
          refreshKey,
          activeIncludeDebugEvents,
          selectionEpoch,
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
          }),
          listRecentEventTurns(activeSessionID, defaultEventTurnPageSize, {
            includeDebug: activeIncludeDebugEvents,
          }),
        ])
        if (closed) return

        const visible = boundEventWindow(appendEvents([], history.events), 'latest', residentEventWindowPolicy)
        const boundedLive = boundEventWindow(appendEvents([], tail.events), 'latest', liveEventWindowPolicy)
        liveEventsRef.current = boundedLive.events
        setLiveEvents(boundedLive.events)
        setEvents(visible.events)
        oldestSeqRef.current = firstSeq(visible.events)
        newestSeqRef.current = lastSeq(visible.events)
        lastSeqRef.current = Math.max(lastSeqRef.current, lastSeq(tail.events), newestSeqRef.current)
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
          lastSeqRef.current,
          true,
        )
        connect(lastSeqRef.current)
      } catch (loadError) {
        if (closed) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load the selected event')
        setStreamState('disconnected')
      }
    }

    async function hydratePersistentCacheOrLoad() {
      setStreamState('loading')
      const persistentSession = await readPersistentCachedSessionEvents(activeSessionID, activeIncludeDebugEvents)
      if (closed) return
      if (persistentSession) {
        const bounded = boundEventWindow(persistentSession.events, 'latest', cachedEventWindowPolicy)
        lastSeqRef.current = persistentSession.lastSeq
        oldestSeqRef.current = firstSeq(bounded.events)
        newestSeqRef.current = lastSeq(bounded.events)
        liveEventsRef.current = bounded.events
        loadedSessionIDRef.current = activeSessionID
        loadedIncludeDebugEventsRef.current = activeIncludeDebugEvents
        setEvents(bounded.events)
        setLiveEvents(bounded.events)
        setHasOlderEvents(persistentSession.hasOlderEvents || bounded.trimmedStart)
        setHasNewerEvents(false)
      }
      await loadTail(false)
    }

    if (targetSeq > 0) {
      void loadTarget()
    } else if (sameSessionRefresh || cachedSession) {
      void loadTail(sameSessionRefresh)
    } else {
      void hydratePersistentCacheOrLoad()
    }

    return () => {
      closed = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      closeSource()
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
      const history = await listEventTurnsBefore(sessionID, beforeSeq, defaultEventTurnPageSize, {
        includeDebug: includeDebugEvents,
      })
      if (activeSessionIDRef.current !== sessionID) return
      if (history.events.length === 0) {
        setHasOlderEvents(false)
        return
      }
      setEvents((current) => {
        const next = mergeBoundedEvents(current, history.events, 'oldest', residentEventWindowPolicy)
        oldestSeqRef.current = firstSeq(next.events)
        newestSeqRef.current = lastSeq(next.events)
        setHasOlderEvents((history.page?.has_older ?? oldestSeqRef.current > 1) || next.trimmedStart)
        setHasNewerEvents(hasNewerEventsRef.current || next.trimmedEnd)
        return next.events
      })
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
      const history = await listEventTurnsAfter(sessionID, afterSeq, defaultEventTurnPageSize, {
        includeDebug: includeDebugEvents,
      })
      if (activeSessionIDRef.current !== sessionID) return
      if (history.events.length === 0) {
        setHasNewerEvents(false)
        followingTailRef.current = true
        return
      }
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
    const immediate = boundEventWindow(liveEventsRef.current, 'latest', residentEventWindowPolicy)
    oldestSeqRef.current = firstSeq(immediate.events)
    newestSeqRef.current = lastSeq(immediate.events)
    setEvents(immediate.events)
    setHasOlderEvents((current) => current || immediate.trimmedStart || oldestSeqRef.current > 1)
    setHasNewerEvents(false)

    try {
      const history = await listRecentEventTurns(sessionID, defaultEventTurnPageSize, {
        includeDebug: includeDebugEvents,
      })
      if (activeSessionIDRef.current !== sessionID) return
      const combined = appendEvents([], [...history.events, ...liveEventsRef.current])
      const next = boundEventWindow(combined, 'latest', residentEventWindowPolicy)
      oldestSeqRef.current = firstSeq(next.events)
      newestSeqRef.current = lastSeq(next.events)
      lastSeqRef.current = Math.max(lastSeqRef.current, newestSeqRef.current)
      setEvents(next.events)
      setHasOlderEvents((history.page?.has_older ?? oldestSeqRef.current > 1) || next.trimmedStart)
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
    streamState,
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
) {
  const key = `${sessionID}:${refreshKey}:${includeDebugEvents ? 'debug' : 'normal'}:${selectionEpoch}`
  const existing = recentEventsRequests.get(key)
  if (existing) return existing

  const request = listRecentEventTurns(sessionID, defaultEventTurnPageSize, {
    includeDebug: includeDebugEvents,
  }).catch((error) => {
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
  persist = false,
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
  if (persist && !includeDebugEvents) {
    schedulePersistentSessionEventsWrite(
      sessionID,
      bounded.events,
      hasOlderEvents || bounded.trimmedStart,
      false,
      Math.max(cursorSeq, lastSeq(bounded.events)),
    )
  }
}

function schedulePersistentSessionEventsWrite(
  sessionID: string,
  events: AgentEvent[],
  hasOlderEvents: boolean,
  includeDebugEvents: boolean,
  cursorSeq: number,
) {
  const cacheKey = sessionEventCacheKey(sessionID, includeDebugEvents)
  const existingTimer = persistentEventsWriteTimers.get(cacheKey)
  if (existingTimer !== undefined) window.clearTimeout(existingTimer)
  const timer = window.setTimeout(() => {
    persistentEventsWriteTimers.delete(cacheKey)
    void writePersistentCachedSessionEvents(sessionID, events, hasOlderEvents, includeDebugEvents, cursorSeq)
  }, persistentEventsWriteDelayMs)
  persistentEventsWriteTimers.set(cacheKey, timer)
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

function evictOldSessionEventCaches() {
  if (sessionEventCache.size <= cachedSessionLimit) return
  const entries = [...sessionEventCache.entries()].sort((left, right) => left[1].usedAt - right[1].usedAt)
  for (const [sessionID] of entries.slice(0, sessionEventCache.size - cachedSessionLimit)) {
    sessionEventCache.delete(sessionID)
  }
}
