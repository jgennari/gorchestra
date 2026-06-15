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

export function useSessionEvents(sessionID: string | null, options: Options = {}) {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [streamState, setStreamState] = useState<StreamState>('idle')
  const [error, setError] = useState('')
  const lastSeqRef = useRef(0)
  const oldestSeqRef = useRef(0)
  const activeSessionIDRef = useRef<string | null>(null)
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
    lastSeqRef.current = 0
    oldestSeqRef.current = 0
    activeSessionIDRef.current = sessionID
    loadingOlderEventsRef.current = false
    setEvents([])
    setError('')
    setHasOlderEvents(false)
    setLoadingOlderEvents(false)

    if (!sessionID) {
      setStreamState('idle')
      return
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
        setEvents((current) => appendEvent(current, event))
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
        lastSeqRef.current = lastSeq(history)
        oldestSeqRef.current = firstSeq(history)
        setHasOlderEvents(oldestSeqRef.current > 1)
        setEvents((current) => appendEvents(current, history))
        connect(lastSeqRef.current)
      } catch (loadError) {
        if (closed) {
          return
        }
        setError(loadError instanceof Error ? loadError.message : 'Failed to load events')
        setStreamState('disconnected')
      }
    }

    void load()

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
        return
      }

      oldestSeqRef.current = firstSeq(history)
      setHasOlderEvents(oldestSeqRef.current > 1)
      setEvents((current) => appendEvents(current, history))
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
