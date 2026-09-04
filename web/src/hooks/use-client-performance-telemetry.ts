import { useEffect, useRef } from 'react'
import { saveClientPerformance, type ClientLongTask } from '@/lib/api'

const telemetryFlushDelayMs = 2_000
const maximumPendingLongTasks = 25

export function useClientPerformanceTelemetry(sessionID: string | null) {
  const sessionIDRef = useRef(sessionID)

  useEffect(() => {
    sessionIDRef.current = sessionID
  }, [sessionID])

  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined') return
    if (
      Array.isArray(PerformanceObserver.supportedEntryTypes) &&
      !PerformanceObserver.supportedEntryTypes.includes('longtask')
    ) {
      return
    }

    let pending: ClientLongTask[] = []
    let flushTimer: number | null = null

    function flush() {
      if (flushTimer !== null) window.clearTimeout(flushTimer)
      flushTimer = null
      if (pending.length === 0) return
      const tasks = pending
      pending = []
      void saveClientPerformance(
        `${window.location.pathname}${window.location.search}`,
        sessionIDRef.current,
        tasks,
      ).catch(() => undefined)
    }

    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < 50 || pending.length >= maximumPendingLongTasks) continue
        pending.push({
          start_time: Math.round(entry.startTime * 100) / 100,
          duration_ms: Math.round(entry.duration * 100) / 100,
        })
      }
      if (pending.length > 0 && flushTimer === null) {
        flushTimer = window.setTimeout(flush, telemetryFlushDelayMs)
      }
    })

    try {
      observer.observe({ type: 'longtask', buffered: true })
    } catch {
      observer.disconnect()
      return
    }
    window.addEventListener('pagehide', flush)
    return () => {
      observer.disconnect()
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])
}
