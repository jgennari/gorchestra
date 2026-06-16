import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvent } from '@/lib/api'
import { eventStreamURL, listEventsBefore, listRecentEvents } from '@/lib/api'
import { appendEvent, appendEvents, knownEventTypes, lastSeq } from '@/lib/events'

export type StreamState = 'idle' | 'loading' | 'connected' | 'reconnecting' | 'disconnected'

type Options = {
  onEvent?: (event: AgentEvent) => void
  reconnectDelayMs?: number
  refreshKey?: number
}

type SessionEventCacheEntry = {
  events: AgentEvent[]
  lastSeq: number
  oldestSeq: number
  hasOlderEvents: boolean
  usedAt: number
}

const cachedSessionLimit = 8
const cachedEventLimit = 5000
const sessionEventCache = new Map<string, SessionEventCacheEntry>()

export function clearSessionEventCacheForTest() {
  sessionEventCache.clear()
}

export function useSessionEvents(sessionID: string | null, options: Options = {}) {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [streamState, setStreamState] = useState<StreamState>('idle')
  const [error, setError] = useState('')
  const lastSeqRef = useRef(0)
  const oldestSeqRef = useRef(0)
  const activeSessionIDRef = useRef<string | null>(null)
  const loadedSessionIDRef = useRef<string | null>(null)
  const loadingOlderEventsRef = useRef(false)
  const onEventRef = useRef(options.onEvent)
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000
  const refreshKey = options.refreshKey ?? 0
  const [hasOlderEvents, setHasOlderEvents] = useState(false)
  const [loadingOlderEvents, setLoadingOlderEvents] = useState(false)

  useEffect(() => {
    onEventRef.current = options.onEvent
  }, [options.onEvent])

  useEffect(() => {
    const sameSessionRefresh = loadedSessionIDRef.current === sessionID
    const cachedSession = sessionID && !sameSessionRefresh ? readCachedSessionEvents(sessionID) : null
    activeSessionIDRef.current = sessionID
    loadingOlderEventsRef.current = false
    setError('')
    setLoadingOlderEvents(false)

    if (!sessionID) {
      lastSeqRef.current = 0
      oldestSeqRef.current = 0
      loadedSessionIDRef.current = null
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
          writeCachedSessionEvents(activeSessionID, next, oldestSeqRef.current > 1)
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

      source = new EventSource(eventStreamURL(activeSessionID, afterSeq))
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

    async function load() {
      setStreamState('loading')
      try {
        const history = await listRecentEvents(activeSessionID)
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
        setHasOlderEvents(oldestSeqRef.current > 1)
        setEvents((current) => {
          const next = appendEvents(sameSessionRefresh ? current : [], history)
          writeCachedSessionEvents(activeSessionID, next, oldestSeqRef.current > 1)
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

    if (cachedSession && !sameSessionRefresh) {
      setStreamState('reconnecting')
      connect(lastSeqRef.current)
    } else {
      void load()
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
  }, [reconnectDelayMs, refreshKey, sessionID])

  const loadOlderEvents = useCallback(async () => {
    if (!sessionID || loadingOlderEventsRef.current) {
      return
    }

    const beforeSeq = oldestSeqRef.current
    if (beforeSeq <= 1) {
      setHasOlderEvents(false)
      setEvents((current) => {
        writeCachedSessionEvents(sessionID, current, false)
        return current
      })
      return
    }

    loadingOlderEventsRef.current = true
    setLoadingOlderEvents(true)
    setError('')

    try {
      const history = await listEventsBefore(sessionID, beforeSeq)
      if (activeSessionIDRef.current !== sessionID) {
        return
      }
      if (history.length === 0) {
        setHasOlderEvents(false)
        setEvents((current) => {
          writeCachedSessionEvents(sessionID, current, false)
          return current
        })
        return
      }

      oldestSeqRef.current = firstSeq(history)
      setHasOlderEvents(oldestSeqRef.current > 1)
      setEvents((current) => {
        const next = appendEvents(current, history)
        writeCachedSessionEvents(sessionID, next, oldestSeqRef.current > 1)
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
  }, [sessionID])

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

function readCachedSessionEvents(sessionID: string): SessionEventCacheEntry | null {
  const entry = sessionEventCache.get(sessionID)
  if (!entry) {
    return null
  }
  const next = { ...entry, usedAt: Date.now() }
  sessionEventCache.set(sessionID, next)
  return next
}

function writeCachedSessionEvents(sessionID: string, events: AgentEvent[], hasOlderEvents: boolean) {
  const trimmedEvents = trimCachedEvents(events)
  const trimmedOlderEvents = trimmedEvents.length < events.length
  sessionEventCache.set(sessionID, {
    events: trimmedEvents,
    lastSeq: lastSeq(trimmedEvents),
    oldestSeq: firstSeq(trimmedEvents),
    hasOlderEvents: hasOlderEvents || trimmedOlderEvents,
    usedAt: Date.now(),
  })
  evictOldSessionEventCaches()
}

function trimCachedEvents(events: AgentEvent[]) {
  if (events.length <= cachedEventLimit) {
    return events
  }
  return events.slice(events.length - cachedEventLimit)
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
