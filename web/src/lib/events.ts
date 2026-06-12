import type { AgentEvent, SessionStatus } from '@/lib/api'

export const knownEventTypes = [
  'user.message.completed',
  'agent.run.started',
  'agent.status.started',
  'agent.message.delta',
  'agent.message.completed',
  'agent.thinking.delta',
  'agent.thinking.completed',
  'agent.log.delta',
  'tool.call.started',
  'tool.call.delta',
  'tool.call.completed',
  'file.change.started',
  'file.change.delta',
  'file.change.completed',
  'provider.codex.event',
  'provider.codex.request',
  'provider.codex.parse_error',
  'agent.run.completed',
  'agent.run.failed',
  'agent.run.cancelled',
] as const

export type DisplayEvent = AgentEvent & {
  display_type?: string
}

export function appendEvent(events: AgentEvent[], event: AgentEvent) {
  if (events.some((existing) => existing.seq === event.seq)) {
    return events
  }
  return [...events, event].sort((left, right) => left.seq - right.seq)
}

export function appendEvents(events: AgentEvent[], nextEvents: AgentEvent[]) {
  return nextEvents.reduce(appendEvent, events)
}

export function lastSeq(events: AgentEvent[]) {
  return events.reduce((max, event) => Math.max(max, event.seq), 0)
}

export function coalesceDisplayEvents(events: AgentEvent[]) {
  const displayEvents: DisplayEvent[] = []

  for (const event of events) {
    const previous = displayEvents[displayEvents.length - 1]
    if (event.type === 'agent.message.delta' && previous?.type === 'agent.message.delta') {
      previous.payload = {
        text: `${payloadText(previous.payload)}${payloadText(event.payload)}`,
      }
      previous.seq = event.seq
      previous.id = event.id
      previous.created_at = event.created_at
      continue
    }
    displayEvents.push({ ...event })
  }

  return displayEvents
}

export function eventLabel(type: string) {
  if (type.startsWith('user.message')) return 'User message'
  if (type.startsWith('agent.message')) return 'Agent message'
  if (type.startsWith('agent.thinking')) return 'Thinking'
  if (type.startsWith('tool.call')) return 'Tool call'
  if (type.startsWith('file.change')) return 'File change'
  if (type === 'agent.log.delta') return 'Log'
  if (type.includes('failed') || type.includes('parse_error')) return 'Error'
  if (type === 'agent.run.completed') return 'Completed'
  if (type === 'agent.run.cancelled') return 'Cancelled'
  return type
}

export function payloadText(payload: unknown) {
  if (isRecord(payload)) {
    const value = payload.text ?? payload.command ?? payload.error ?? payload.summary
    if (typeof value === 'string') {
      return value
    }
  }
  return ''
}

export function payloadError(payload: unknown) {
  if (!isRecord(payload)) {
    return ''
  }
  const value = payload.error
  return typeof value === 'string' ? value : ''
}

export function statusFromEvent(type: string): SessionStatus | null {
  switch (type) {
    case 'agent.run.started':
      return 'running'
    case 'agent.run.completed':
      return 'completed'
    case 'agent.run.failed':
      return 'failed'
    case 'agent.run.cancelled':
      return 'cancelled'
    default:
      return null
  }
}

export function isTerminalEvent(type: string) {
  return type === 'agent.run.completed' || type === 'agent.run.failed' || type === 'agent.run.cancelled'
}

export function isErrorEvent(type: string, status: string) {
  return status === 'failed' || type === 'provider.codex.parse_error' || type === 'agent.run.failed'
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
