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

export type EventGroupKind =
  | 'user-message'
  | 'agent-message'
  | 'thinking'
  | 'tool-call'
  | 'file-change'
  | 'log'
  | 'error'
  | 'terminal'
  | 'unknown'

export type EventGroup = {
  id: string
  kind: EventGroupKind
  label: string
  status: string
  startSeq: number
  endSeq: number
  events: AgentEvent[]
  text: string
  error: string
  paths: string[]
  defaultOpen: boolean
  terminal: boolean
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

export function groupEvents(events: AgentEvent[]) {
  const groups: EventGroup[] = []
  const toolGroupsByID = new Map<string, EventGroup>()

  for (const event of sortedUniqueEvents(events)) {
    const previous = groups[groups.length - 1]
    const toolID = toolGroupID(event)

    if (
      event.type === 'agent.message.delta' &&
      previous?.kind === 'agent-message' &&
      previous.events[previous.events.length - 1]?.type === 'agent.message.delta' &&
      previous.events[previous.events.length - 1]?.session_id === event.session_id
    ) {
      appendToGroup(previous, event)
      continue
    }

    if (
      event.type === 'agent.thinking.delta' &&
      previous?.kind === 'thinking' &&
      previous.events[previous.events.length - 1]?.type === 'agent.thinking.delta'
    ) {
      appendToGroup(previous, event)
      continue
    }

    if (event.type === 'agent.log.delta' && previous?.kind === 'log') {
      appendToGroup(previous, event)
      continue
    }

    if (event.type.startsWith('tool.call')) {
      const toolGroup = toolID ? toolGroupsByID.get(toolID) : nearbyToolGroup(previous, event)
      if (toolGroup) {
        appendToGroup(toolGroup, event)
        continue
      }

      const group = newGroup(event)
      groups.push(group)
      if (toolID) {
        toolGroupsByID.set(toolID, group)
      }
      continue
    }

    if (event.type.startsWith('file.change') && previous?.kind === 'file-change' && event.seq - previous.endSeq <= 2) {
      appendToGroup(previous, event)
      continue
    }

    groups.push(newGroup(event))
  }

  return groups
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
    const value =
      payload.text ??
      payload.delta ??
      payload.output ??
      payload.command ??
      payload.error ??
      payload.summary ??
      payload.message
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
  const value = payload.error ?? payload.message
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

function sortedUniqueEvents(events: AgentEvent[]) {
  const bySeq = new Map<number, AgentEvent>()
  for (const event of events) {
    if (!bySeq.has(event.seq)) {
      bySeq.set(event.seq, event)
    }
  }
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq)
}

function newGroup(event: AgentEvent): EventGroup {
  const kind = groupKind(event)
  const group: EventGroup = {
    id: groupID(event),
    kind,
    label: groupLabel(event, kind),
    status: event.status,
    startSeq: event.seq,
    endSeq: event.seq,
    events: [event],
    text: payloadText(event.payload),
    error: payloadError(event.payload),
    paths: payloadPaths(event.payload),
    defaultOpen: defaultOpen(kind, event),
    terminal: isTerminalEvent(event.type),
  }
  return group
}

function appendToGroup(group: EventGroup, event: AgentEvent) {
  group.events.push(event)
  group.endSeq = event.seq
  group.status = event.status
  group.text = joinGroupText(group.text, payloadText(event.payload))
  group.error = group.error || payloadError(event.payload)
  group.paths = uniqueStrings([...group.paths, ...payloadPaths(event.payload)])
  group.defaultOpen = group.events.some((item) => isErrorEvent(item.type, item.status)) || defaultOpen(group.kind, event)
  group.terminal = group.terminal || isTerminalEvent(event.type)
}

function groupKind(event: AgentEvent): EventGroupKind {
  if (isErrorEvent(event.type, event.status)) return 'error'
  if (event.type === 'user.message.completed') return 'user-message'
  if (event.type.startsWith('agent.message')) return 'agent-message'
  if (event.type.startsWith('agent.thinking')) return 'thinking'
  if (event.type.startsWith('tool.call')) return 'tool-call'
  if (event.type.startsWith('file.change')) return 'file-change'
  if (event.type === 'agent.log.delta') return 'log'
  if (isTerminalEvent(event.type)) return 'terminal'
  return 'unknown'
}

function groupLabel(event: AgentEvent, kind: EventGroupKind) {
  if (kind === 'tool-call') {
    const name = payloadString(event.payload, ['tool', 'name', 'command'])
    return name ? `Tool: ${name}` : 'Tool call'
  }
  if (kind === 'file-change') {
    return 'File change'
  }
  return eventLabel(event.type)
}

function groupID(event: AgentEvent) {
  if (event.type.startsWith('tool.call')) {
    const toolID = toolGroupID(event)
    if (toolID) return `tool-${toolID}`
  }
  return `${groupKind(event)}-${event.seq}`
}

function toolGroupID(event: AgentEvent) {
  if (!event.type.startsWith('tool.call')) {
    return ''
  }
  return payloadString(event.payload, [
    'tool_call_id',
    'call_id',
    'item_id',
    'process_id',
    'tool_id',
    'id',
  ])
}

function nearbyToolGroup(previous: EventGroup | undefined, event: AgentEvent) {
  if (!previous || previous.kind !== 'tool-call') {
    return null
  }
  if (event.seq - previous.endSeq > 2) {
    return null
  }
  return previous
}

function payloadPaths(payload: unknown) {
  if (!isRecord(payload)) {
    return []
  }

  const paths = new Set<string>()
  addPathValue(paths, payload.path)
  addPathValue(paths, payload.file)
  addPathValue(paths, payload.files)
  addPathValue(paths, payload.paths)
  addPathValue(paths, payload.changes)
  return [...paths]
}

function addPathValue(paths: Set<string>, value: unknown) {
  if (typeof value === 'string' && value.trim()) {
    paths.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        addPathValue(paths, item)
      } else if (isRecord(item)) {
        addPathValue(paths, item.path ?? item.file)
      }
    }
  }
}

function payloadString(payload: unknown, keys: string[]) {
  if (!isRecord(payload)) {
    return ''
  }
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
    if (typeof value === 'number') {
      return String(value)
    }
  }
  return ''
}

function joinGroupText(current: string, next: string) {
  if (!current) return next
  if (!next) return current
  return `${current}${next}`
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)]
}

function defaultOpen(kind: EventGroupKind, event: AgentEvent) {
  if (isErrorEvent(event.type, event.status)) return true
  if (kind === 'unknown') return false
  if ((kind === 'tool-call' || kind === 'file-change' || kind === 'log') && event.status === 'completed') {
    return false
  }
  return true
}
