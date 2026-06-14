import { useEffect, useRef, useState } from 'react'
import type { AgentEvent } from '@/lib/api'
import { eventStreamURL, listEvents } from '@/lib/api'
import { appendEvent, appendEvents, knownEventTypes, lastSeq } from '@/lib/events'

export type StreamState = 'idle' | 'loading' | 'connected' | 'reconnecting' | 'disconnected'

type Options = {
  onEvent?: (event: AgentEvent) => void
  reconnectDelayMs?: number
}

export function useSessionEvents(sessionID: string | null, options: Options = {}) {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [streamState, setStreamState] = useState<StreamState>('idle')
  const [error, setError] = useState('')
  const lastSeqRef = useRef(0)
  const onEventRef = useRef(options.onEvent)
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000

  useEffect(() => {
    onEventRef.current = options.onEvent
  }, [options.onEvent])

  useEffect(() => {
    lastSeqRef.current = 0
    setEvents([])
    setError('')

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
        const history = await listEvents(activeSessionID, 0, 1000)
        if (closed) {
          return
        }
        lastSeqRef.current = lastSeq(history)
        setEvents((current) => appendEvents(current, history))
        for (const event of history) {
          onEventRef.current?.(event)
        }
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
      setStreamState('disconnected')
    }
  }, [reconnectDelayMs, sessionID])

  return {
    events,
    streamState,
    error,
  }
}
