import type { AgentEvent } from '@/lib/api'
import { appendEvent, appendEvents, isTerminalEvent, isTransientEvent } from '@/lib/events'

export const residentEventWindowPolicy = {
  maxTurns: 50,
  maxDurableEvents: 5000,
  maxBytes: 8 * 1024 * 1024,
  maxTransientEvents: 200,
  maxTransientBytes: 512 * 1024,
} as const

export const liveEventWindowPolicy = {
  maxTurns: 50,
  maxDurableEvents: 1000,
  maxBytes: 2 * 1024 * 1024,
  maxTransientEvents: 200,
  maxTransientBytes: 512 * 1024,
} as const

export const cachedEventWindowPolicy = {
  maxTurns: 50,
  maxDurableEvents: 1000,
  maxBytes: 2 * 1024 * 1024,
  maxTransientEvents: 0,
  maxTransientBytes: 0,
} as const

export type EventWindowPolicy = {
  maxTurns: number
  maxDurableEvents: number
  maxBytes: number
  maxTransientEvents: number
  maxTransientBytes: number
}

export type EventWindowDirection = 'oldest' | 'latest'

export type BoundedEventWindow = {
  events: AgentEvent[]
  trimmedStart: boolean
  trimmedEnd: boolean
}

const eventByteCache = new WeakMap<object, number>()

export function appendBoundedEvent(
  events: AgentEvent[],
  event: AgentEvent,
  policy: EventWindowPolicy = residentEventWindowPolicy,
) {
  const appended = appendLiveEvent(events, event)
  const settled = isTerminalEvent(event.type) ? appended.filter((item) => !isTransientEvent(item)) : appended
  return boundEventWindow(settled, 'latest', policy)
}

export function mergeBoundedEvents(
  events: AgentEvent[],
  incoming: AgentEvent[],
  direction: EventWindowDirection,
  policy: EventWindowPolicy = residentEventWindowPolicy,
) {
  return boundEventWindow(appendEvents(events, incoming), direction, policy)
}

export function boundEventWindow(
  events: AgentEvent[],
  direction: EventWindowDirection,
  policy: EventWindowPolicy = residentEventWindowPolicy,
): BoundedEventWindow {
  const sorted = windowSafeEvents(uniqueEvents(events), policy)
  if (sorted.length === 0) {
    return { events: [], trimmedStart: false, trimmedEnd: false }
  }

  let turns = 0
  let durableEvents = 0
  let transientEvents = 0
  let bytes = 0
  let transientBytes = 0
  let start = direction === 'latest' ? sorted.length : 0
  let end = direction === 'latest' ? sorted.length : 0

  const indices =
    direction === 'latest'
      ? Array.from({ length: sorted.length }, (_, index) => sorted.length - index - 1)
      : Array.from({ length: sorted.length }, (_, index) => index)

  for (const index of indices) {
    if (direction === 'latest' && turns >= policy.maxTurns) {
      break
    }
    const event = sorted[index]
    const eventBytes = serializedEventBytes(event)
    const transient = isTransientEvent(event)
    const nextTurns = turns + (event.type === 'user.message.completed' ? 1 : 0)
    const nextDurableEvents = durableEvents + (transient ? 0 : 1)
    const nextTransientEvents = transientEvents + (transient ? 1 : 0)
    const nextBytes = bytes + eventBytes
    const nextTransientBytes = transientBytes + (transient ? eventBytes : 0)
    const selected = direction === 'latest' ? start < sorted.length : end > 0
    const exceeds =
      nextTurns > policy.maxTurns ||
      nextDurableEvents > policy.maxDurableEvents ||
      nextBytes > policy.maxBytes ||
      nextTransientEvents > policy.maxTransientEvents ||
      nextTransientBytes > policy.maxTransientBytes

    if (exceeds && selected) {
      break
    }

    turns = nextTurns
    durableEvents = nextDurableEvents
    transientEvents = nextTransientEvents
    bytes = nextBytes
    transientBytes = nextTransientBytes
    if (direction === 'latest') {
      start = index
    } else {
      end = index + 1
    }
  }

  const bounded = direction === 'latest' ? sorted.slice(start) : sorted.slice(0, end)
  return {
    events: bounded,
    trimmedStart: start > 0,
    trimmedEnd: end > 0 && end < sorted.length,
  }
}

export function eventWindowStats(events: AgentEvent[]) {
  let turns = 0
  let durableEvents = 0
  let transientEvents = 0
  let bytes = 0
  for (const event of events) {
    if (event.type === 'user.message.completed') turns += 1
    if (isTransientEvent(event)) transientEvents += 1
    else durableEvents += 1
    bytes += serializedEventBytes(event)
  }
  return { turns, durableEvents, transientEvents, bytes }
}

function appendLiveEvent(events: AgentEvent[], event: AgentEvent) {
  if (!isTransientEvent(event)) {
    return appendEvent(events, event)
  }

  const key = transientKey(event)
  const existingIndex = events.findIndex((item) => isTransientEvent(item) && transientKey(item) === key)
  if (existingIndex < 0) {
    return appendEvent(events, event)
  }

  const existing = events[existingIndex]
  const next = events.filter((_, index) => index !== existingIndex)
  return appendEvent(next, {
    ...event,
    payload: mergeTransientPayload(existing.payload, event.payload),
  })
}

function transientKey(event: AgentEvent) {
  const payload = event.payload && typeof event.payload === 'object' ? (event.payload as Record<string, unknown>) : {}
  const identityKeys = ['tool_call_id', 'file_change_id', 'item_id', 'message_id', 'plan_id', 'id']
  for (const key of identityKeys) {
    if (typeof payload[key] === 'string' && payload[key]) {
      return `${event.type}:${payload[key]}`
    }
  }
  return event.type
}

function mergeTransientPayload(previous: unknown, next: unknown) {
  if (!isRecord(previous) || !isRecord(next)) {
    return next
  }
  const previousText = typeof previous.text === 'string' ? previous.text : ''
  const nextText = typeof next.text === 'string' ? next.text : ''
  return {
    ...previous,
    ...next,
    ...(previousText || nextText ? { text: `${previousText}${nextText}` } : {}),
  }
}

function uniqueEvents(events: AgentEvent[]) {
  const bySeq = new Map<number, AgentEvent>()
  for (const event of events) {
    bySeq.set(event.seq, event)
  }
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq)
}

function serializedEventBytes(event: AgentEvent) {
  const cached = eventByteCache.get(event)
  if (cached !== undefined) return cached
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength
    eventByteCache.set(event, bytes)
    return bytes
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

function windowSafeEvents(events: AgentEvent[], policy: EventWindowPolicy) {
  return events.flatMap((event) => {
    const transient = isTransientEvent(event)
    if (transient && policy.maxTransientEvents <= 0) return []
    const eventLimit = transient ? Math.min(policy.maxBytes, policy.maxTransientBytes) : policy.maxBytes
    if (serializedEventBytes(event) <= eventLimit) return [event]
    const compactEvent = { ...event, payload: { _gorchestra_window_truncated: true } }
    return serializedEventBytes(compactEvent) <= eventLimit ? [compactEvent] : []
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
