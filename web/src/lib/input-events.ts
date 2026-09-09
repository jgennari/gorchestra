import type { AgentEvent, EventHistoryResponse } from '@/lib/api'
import { appendEvents, isRecord, isTerminalEvent } from '@/lib/events'

// Small, independent control state: never evict unanswered questions just because
// a long-running turn overflows the bounded transcript/live-activity windows.
export function unresolvedInputEvents(events: AgentEvent[]): AgentEvent[] {
  const requests = new Map<string, AgentEvent[]>()
  let terminal: AgentEvent | undefined
  for (const event of appendEvents([], events)) {
    if (isTerminalEvent(event.type)) { requests.clear(); terminal = event }
    if (!event.type.startsWith('agent.input.') || !isRecord(event.payload)) continue
    const id = typeof event.payload.request_id === 'string' ? event.payload.request_id : ''
    if (!id) continue
    if (event.type === 'agent.input.requested') requests.set(id, [event])
    // Keep a compact resolution tombstone until the next authoritative snapshot;
    // otherwise an HTTP response that raced this answer could resurrect it.
    if (event.type === 'agent.input.answered') requests.set(id, [event])
    if (event.type === 'agent.input.submitted' || event.type === 'agent.input.failed') {
      const request = requests.get(id)?.[0]
      if (request) requests.set(id, [request, event])
    }
  }
  return appendEvents([], [...(terminal ? [terminal] : []), ...[...requests.values()].flat()])
}

export function reconcileInputEvents(current: AgentEvent[], history: EventHistoryResponse): AgentEvent[] {
  const watermark = history.page?.server_last_seq ?? Math.max(0, ...history.events.map(event => event.seq))
  return unresolvedInputEvents([
    ...(history.input_events ?? [...current.filter(event => event.seq <= watermark), ...history.events]),
    ...current.filter(event => event.seq > watermark),
  ])
}
