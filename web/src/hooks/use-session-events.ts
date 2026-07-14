import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvent } from '@/lib/api'
import {
  defaultEventTurnPageSize,
  eventStreamURL,
  listEventTurnsBefore,
  listRecentEventTurns,
} from '@/lib/api'
import { appendEvent, appendEvents, isTransientEvent, knownEventTypes, lastSeq } from '@/lib/events'
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
}

type SessionEventCacheEntry = {
  events: AgentEvent[]
  lastSeq: number
  oldestSeq: number
  hasOlderEvents: boolean
  usedAt: number
}

const cachedSessionLimit = 8
const recentEventsRequestRetentionMs = 2000
const persistentEventsWriteDelayMs = 1200
const sessionEventCache = new Map<string, SessionEventCacheEntry>()
const recentEventsRequests = new Map<string, Promise<AgentEvent[]>>()
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
  const [streamState, setStreamState] = useState<StreamState>('idle')
  const [error, setError] = useState('')
  const lastSeqRef = useRef(0)
  const oldestSeqRef = useRef(0)
  const activeSessionIDRef = useRef<string | null>(null)
  const loadedSessionIDRef = useRef<string | null>(null)
  const loadedIncludeDebugEventsRef = useRef(false)
  const loadingOlderEventsRef = useRef(false)
  const onEventRef = useRef(options.onEvent)
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000
  const refreshKey = options.refreshKey ?? 0
  const includeDebugEvents = options.includeDebugEvents ?? false
  const [hasOlderEvents, setHasOlderEvents] = useState(false)
  const [loadingOlderEvents, setLoadingOlderEvents] = useState(false)

  useEffect(() => {
    onEventRef.current = options.onEvent
  }, [options.onEvent])

  useEffect(() => {
    const sameSessionRefresh =
      loadedSessionIDRef.current === sessionID && loadedIncludeDebugEventsRef.current === includeDebugEvents
    const cachedSession = sessionID && !sameSessionRefresh ? readCachedSessionEvents(sessionID, includeDebugEvents) : null
    activeSessionIDRef.current = sessionID
    loadingOlderEventsRef.current = false
    setError('')
    setLoadingOlderEvents(false)

    if (!sessionID) {
      lastSeqRef.current = 0
      oldestSeqRef.current = 0
      loadedSessionIDRef.current = null
      loadedIncludeDebugEventsRef.current = false
      setEvents([])
      setHasOlderEvents(false)
      setStreamState('idle')
      return
    }

    if (!sameSessionRefresh) {
      if (cachedSession) {
        lastSeqRef.current = cachedSession.lastSeq
        oldestSeqRef.current = cachedSession.oldestSeq
        loadedSessionIDRef.current = sessionID
        loadedIncludeDebugEventsRef.current = includeDebugEvents
        setEvents(cachedSession.events)
        setHasOlderEvents(cachedSession.hasOlderEvents)
      } else {
        lastSeqRef.current = 0
        oldestSeqRef.current = 0
        setEvents([])
        setHasOlderEvents(false)
      }
    }

    const activeSessionID = sessionID
    const activeIncludeDebugEvents = includeDebugEvents
    let closed = false
    let source: EventSource | null = null
    let reconnectTimer: number | undefined

    function closeSource() {
      source?.close()
      source = null
    }

    function scheduleReconnect() {
      if (closed) {
        return
      }
      setStreamState('reconnecting')
      closeSource()
      reconnectTimer = window.setTimeout(() => {
        connect(lastSeqRef.current)
      }, reconnectDelayMs)
    }

    function handleEvent(message: MessageEvent<string>) {
      try {
        const event = JSON.parse(message.data) as AgentEvent
        lastSeqRef.current = Math.max(lastSeqRef.current, event.seq)
        setEvents((current) => {
          const next = appendEvent(current, event)
          oldestSeqRef.current = firstSeq(next)
          const nextHasOlderEvents = oldestSeqRef.current > 1
          setHasOlderEvents(nextHasOlderEvents)
          writeCachedSessionEvents(activeSessionID, next, nextHasOlderEvents, activeIncludeDebugEvents, lastSeqRef.current)
          return next
        })
        onEventRef.current?.(event)
      } catch (eventError) {
        setError(eventError instanceof Error ? eventError.message : 'Failed to parse event')
      }
    }

    function connect(afterSeq: number) {
      if (closed) {
        return
      }

      source = new EventSource(eventStreamURL(activeSessionID, afterSeq, { includeDebug: activeIncludeDebugEvents }))
      source.onopen = () => {
        if (!closed) {
          setStreamState('connected')
          setError('')
        }
      }
      source.onerror = () => {
        if (!closed) {
          scheduleReconnect()
        }
      }
      for (const eventType of knownEventTypes) {
        source.addEventListener(eventType, handleEvent)
      }
    }

    async function loadRecentHistory() {
      setStreamState('loading')
      try {
        const history = await listRecentEventsOnce(activeSessionID, refreshKey, activeIncludeDebugEvents)
        if (closed) {
          return
        }
        const historyLastSeq = lastSeq(history)
        const historyFirstSeq = firstSeq(history)
        lastSeqRef.current = sameSessionRefresh ? Math.max(lastSeqRef.current, historyLastSeq) : historyLastSeq
        if (sameSessionRefresh && oldestSeqRef.current > 0 && historyFirstSeq > 0) {
          oldestSeqRef.current = Math.min(oldestSeqRef.current, historyFirstSeq)
        } else {
          oldestSeqRef.current = historyFirstSeq
        }
        loadedSessionIDRef.current = activeSessionID
        loadedIncludeDebugEventsRef.current = activeIncludeDebugEvents
        const nextHasOlderEvents = oldestSeqRef.current > 1
        setHasOlderEvents(nextHasOlderEvents)
        setEvents((current) => {
          const next = appendEvents(sameSessionRefresh ? current : [], history)
          oldestSeqRef.current = firstSeq(next)
          setHasOlderEvents(nextHasOlderEvents)
          writeCachedSessionEvents(
            activeSessionID,
            next,
            nextHasOlderEvents,
            activeIncludeDebugEvents,
            lastSeqRef.current,
          )
          return next
        })
        connect(lastSeqRef.current)
      } catch (loadError) {
        if (closed) {
          return
        }
        setError(loadError instanceof Error ? loadError.message : 'Failed to load events')
        setStreamState('disconnected')
      }
    }

    async function hydratePersistentCacheOrLoad() {
      setStreamState('loading')
      const persistentSession = await readPersistentCachedSessionEvents(activeSessionID, activeIncludeDebugEvents)
      if (closed) {
        return
      }
      if (!persistentSession) {
        await loadRecentHistory()
        return
      }

      lastSeqRef.current = persistentSession.lastSeq
      oldestSeqRef.current = persistentSession.oldestSeq
      loadedSessionIDRef.current = activeSessionID
      loadedIncludeDebugEventsRef.current = activeIncludeDebugEvents
      setEvents(persistentSession.events)
      setHasOlderEvents(persistentSession.hasOlderEvents)
      writeCachedSessionEvents(
        activeSessionID,
        persistentSession.events,
        persistentSession.hasOlderEvents,
        activeIncludeDebugEvents,
        persistentSession.lastSeq,
      )
      await loadRecentHistory()
    }

    if (cachedSession && !sameSessionRefresh) {
      setStreamState('reconnecting')
      connect(lastSeqRef.current)
    } else if (!sameSessionRefresh && !cachedSession) {
      void hydratePersistentCacheOrLoad()
    } else {
      void loadRecentHistory()
    }

    return () => {
      closed = true
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer)
      }
      closeSource()
      if (activeSessionIDRef.current === activeSessionID) {
        activeSessionIDRef.current = null
      }
      setStreamState('disconnected')
    }
  }, [includeDebugEvents, reconnectDelayMs, refreshKey, sessionID])

  const loadOlderEvents = useCallback(async () => {
    if (!sessionID || loadingOlderEventsRef.current) {
      return
    }

    const beforeSeq = oldestSeqRef.current
    if (beforeSeq <= 1) {
      setHasOlderEvents(false)
      setEvents((current) => {
        writeCachedSessionEvents(sessionID, current, false, includeDebugEvents, lastSeqRef.current)
        return current
      })
      return
    }

    loadingOlderEventsRef.current = true
    setLoadingOlderEvents(true)
    setError('')

    try {
      const history = await listEventTurnsBefore(sessionID, beforeSeq, defaultEventTurnPageSize, {
        includeDebug: includeDebugEvents,
      })
      if (activeSessionIDRef.current !== sessionID) {
        return
      }
      if (history.length === 0) {
        setHasOlderEvents(false)
        setEvents((current) => {
          writeCachedSessionEvents(sessionID, current, false, includeDebugEvents, lastSeqRef.current)
          return current
        })
        return
      }

      oldestSeqRef.current = firstSeq(history)
      setHasOlderEvents(oldestSeqRef.current > 1)
      setEvents((current) => {
        const next = appendEvents(current, history)
        writeCachedSessionEvents(sessionID, next, oldestSeqRef.current > 1, includeDebugEvents, lastSeqRef.current)
        return next
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
  }, [includeDebugEvents, sessionID])

  return {
    events,
    streamState,
    error,
    hasOlderEvents,
    loadingOlderEvents,
    loadOlderEvents,
  }
}

function firstSeq(events: AgentEvent[]) {
  return events.reduce((min, event) => (min === 0 ? event.seq : Math.min(min, event.seq)), 0)
}

function listRecentEventsOnce(sessionID: string, refreshKey: number, includeDebugEvents: boolean) {
  const key = `${sessionID}:${refreshKey}:${includeDebugEvents ? 'debug' : 'normal'}`
  const existing = recentEventsRequests.get(key)
  if (existing) {
    return existing
  }

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
        if (recentEventsRequests.get(key) === request) {
          recentEventsRequests.delete(key)
        }
      }, recentEventsRequestRetentionMs)
    },
    () => undefined,
  )
  return request
}

function readCachedSessionEvents(sessionID: string, includeDebugEvents: boolean): SessionEventCacheEntry | null {
  const cacheKey = sessionEventCacheKey(sessionID, includeDebugEvents)
  const entry = sessionEventCache.get(cacheKey)
  if (!entry) {
    return null
  }
  const next = { ...entry, usedAt: Date.now() }
  sessionEventCache.set(cacheKey, next)
  return next
}

function writeCachedSessionEvents(
  sessionID: string,
  events: AgentEvent[],
  hasOlderEvents: boolean,
  includeDebugEvents: boolean,
  cursorSeq = lastSeq(events),
) {
  const cacheKey = sessionEventCacheKey(sessionID, includeDebugEvents)
  const cacheableEvents = events.filter((event) => !isTransientEvent(event))
  const trimmedEvents = trimEventsToRecentTurns(cacheableEvents, defaultEventTurnPageSize)
  const trimmedOlderEvents = trimmedEvents.length < cacheableEvents.length
  sessionEventCache.set(cacheKey, {
    events: trimmedEvents,
    lastSeq: Math.max(cursorSeq, lastSeq(trimmedEvents)),
    oldestSeq: firstSeq(trimmedEvents),
    hasOlderEvents: hasOlderEvents || trimmedOlderEvents,
    usedAt: Date.now(),
  })
  evictOldSessionEventCaches()
  schedulePersistentSessionEventsWrite(
    sessionID,
    trimmedEvents,
    hasOlderEvents || trimmedOlderEvents,
    includeDebugEvents,
    Math.max(cursorSeq, lastSeq(trimmedEvents)),
  )
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
  if (existingTimer !== undefined) {
    window.clearTimeout(existingTimer)
  }
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
  if (turns <= 0) {
    return []
  }
  let foundTurns = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type !== 'user.message.completed') {
      continue
    }
    foundTurns += 1
    if (foundTurns === turns) {
      return events.slice(index)
    }
  }
  return events
}

function evictOldSessionEventCaches() {
  if (sessionEventCache.size <= cachedSessionLimit) {
    return
  }
  const entries = [...sessionEventCache.entries()].sort((left, right) => left[1].usedAt - right[1].usedAt)
  for (const [sessionID] of entries.slice(0, sessionEventCache.size - cachedSessionLimit)) {
    sessionEventCache.delete(sessionID)
  }
}
