import { createContext } from 'react'
import type { AgentEvent } from '@/lib/api'

export const ClientDebugContext = createContext<boolean | null>(null)
const debugParams = ['debug', 'debug-scroll', 'viewportDebug']

export function clientDebugEnabled(search = typeof window === 'undefined' ? '' : window.location.search) {
  const params = new URLSearchParams(search)
  return debugParams.some((key) => ['1', 'true'].includes(params.get(key) ?? ''))
}

export function clientDebugURL(path: string, enabled = clientDebugEnabled()) {
  const url = new URL(path, 'http://debug.local')
  for (const key of debugParams) url.searchParams.delete(key)
  if (enabled) url.searchParams.set('debug', '1')
  return `${url.pathname}${url.search}${url.hash}`
}

// Bounded, memory-only metadata. No payloads, drafts, telemetry, or event log.
// Recording is independent of the panel so toggling cannot restart the SSE.
export function createClientDebugTransport() {
  return {
    attempts: 0,
    errors: 0,
    received: 0,
    rejected: 0,
    sourceState: 'closed' as 'closed' | 'connecting' | 'open',
    requestedCursor: 0,
    openedAt: 0,
    errorAt: 0,
    retryAt: 0,
    resyncs: 0,
    resyncAt: 0,
    resyncReason: '',
    lastEvent: null as ReturnType<typeof debugEventMetadata> | null,
  }
}

export function debugEventMetadata(event: AgentEvent) {
  return {
    type: event.type,
    session: event.session_id,
    seq: event.seq,
    cursor: event.global_seq ?? 0,
    transient: Boolean(event.transient),
    createdAt: event.created_at,
    receivedAt: Date.now(),
  }
}

export function debugTime(timestamp: number | string, now = Date.now()) {
  const time = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp)
  if (!time || !Number.isFinite(time)) return 'none'
  return `${new Date(time).toLocaleTimeString()} (${Math.max(0, Math.floor((now - time) / 1000))}s ago)`
}

export function debugEventRange(events: AgentEvent[]) {
  if (events.length === 0) return 'empty'
  return `#${events[0].seq}–${events.at(-1)!.seq} (${events.length} events)`
}

export function latestDebugMessage(...windows: AgentEvent[][]) {
  let latest: AgentEvent | undefined
  for (const events of windows) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type !== 'user.message.completed' && event.type !== 'agent.message.completed') continue
      if (!latest || event.seq > latest.seq) latest = event
      break
    }
  }
  if (!latest) return { message: 'No completed message in loaded history', preview: '' }
  const payload = latest.payload
  const text = payload && typeof payload === 'object' && 'text' in payload && typeof payload.text === 'string' ? payload.text : ''
  return {
    message: `${latest.type.startsWith('user.') ? 'user' : 'agent'} #${latest.seq} · ${debugTime(latest.created_at)}`,
    preview: text ? `${text.slice(0, 160).replace(/\s+/g, ' ')}${text.length > 160 ? '…' : ''}` : '(no text)',
  }
}

export type ClientDebugSnapshot = {
  stream: Record<string, string>
  history: Record<string, string>
  message: string
  preview: string
}
