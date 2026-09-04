import type { AgentEvent } from '@/lib/api'
import { isTransientEvent, lastSeq } from '@/lib/events'
import {
  appendBoundedEvent,
  boundEventWindow,
  cachedEventWindowPolicy,
  eventWindowStats,
  mergeBoundedEvents,
} from '@/lib/session-event-window'
import { writeCachedSessionEvent as writePersistentCachedSessionEvent } from '@/lib/session-cache'

export type ClientSessionEventSnapshot = {
  events: AgentEvent[]
  lastSeq: number
  oldestSeq: number
  hasOlderEvents: boolean
  hasNewerEvents: boolean
}

type ClientSessionEventEntry = ClientSessionEventSnapshot & {
  usedAt: number
  bytes: number
}

type SessionEventListener = (event: AgentEvent, snapshot: ClientSessionEventSnapshot) => void

const memoryEventBytesLimit = 32 * 1024 * 1024
const memoryEventEntryLimit = 50
const entries = new Map<string, ClientSessionEventEntry>()
const cursors = new Map<string, number>()
const listeners = new Map<string, Set<SessionEventListener>>()

export function ingestClientEvent(event: AgentEvent) {
  if (!event.session_id || isTransientEvent(event)) return false

  const cursor = cursors.get(event.session_id) ?? 0
  if (event.seq <= cursor) return false

  const current = entries.get(event.session_id)
  const bounded = appendBoundedEvent(current?.events ?? [], event, cachedEventWindowPolicy)
  const snapshot = setEntry(event.session_id, bounded.events, {
    lastSeq: event.seq,
    hasOlderEvents: Boolean(current?.hasOlderEvents) || bounded.trimmedStart || firstSeq(bounded.events) > 1,
    hasNewerEvents: false,
  })
  cursors.set(event.session_id, event.seq)
  void writePersistentCachedSessionEvent(event.session_id, event, event.seq)

  for (const listener of listeners.get(event.session_id) ?? []) {
    listener(event, snapshot)
  }
  return true
}

export function seedClientSessionEvents(
  sessionID: string,
  events: AgentEvent[],
  options: {
    lastSeq?: number
    hasOlderEvents?: boolean
    hasNewerEvents?: boolean
    replace?: boolean
  } = {},
) {
  const durableEvents = events.filter((event) => !isTransientEvent(event))
  const current = entries.get(sessionID)
  const bounded = options.replace
    ? boundEventWindow(durableEvents, 'latest', cachedEventWindowPolicy)
    : mergeBoundedEvents(current?.events ?? [], durableEvents, 'latest', cachedEventWindowPolicy)
  const cursor = Math.max(cursors.get(sessionID) ?? 0, options.lastSeq ?? 0, lastSeq(durableEvents))
  cursors.set(sessionID, cursor)
  return setEntry(sessionID, bounded.events, {
    lastSeq: cursor,
    hasOlderEvents:
      options.hasOlderEvents === true ||
      (options.replace ? false : current?.hasOlderEvents === true) ||
      bounded.trimmedStart ||
      firstSeq(bounded.events) > 1,
    hasNewerEvents: options.hasNewerEvents ?? (options.replace ? false : current?.hasNewerEvents ?? false),
  })
}

export function readClientSessionEvents(sessionID: string): ClientSessionEventSnapshot | null {
  const entry = entries.get(sessionID)
  if (!entry) return null
  entry.usedAt = Date.now()
  return snapshotFromEntry(entry)
}

export function subscribeClientSessionEvents(sessionID: string, listener: SessionEventListener) {
  const sessionListeners = listeners.get(sessionID) ?? new Set<SessionEventListener>()
  sessionListeners.add(listener)
  listeners.set(sessionID, sessionListeners)
  return () => {
    sessionListeners.delete(listener)
    if (sessionListeners.size === 0) listeners.delete(sessionID)
  }
}

export function clientEventStoreStats() {
  return {
    sessions: entries.size,
    cursors: cursors.size,
    bytes: [...entries.values()].reduce((total, entry) => total + entry.bytes, 0),
  }
}

export function clearClientEventStoreForTest() {
  entries.clear()
  cursors.clear()
  listeners.clear()
}

function setEntry(
  sessionID: string,
  events: AgentEvent[],
  options: Pick<ClientSessionEventSnapshot, 'lastSeq' | 'hasOlderEvents' | 'hasNewerEvents'>,
) {
  const entry: ClientSessionEventEntry = {
    events,
    lastSeq: Math.max(options.lastSeq, lastSeq(events)),
    oldestSeq: firstSeq(events),
    hasOlderEvents: options.hasOlderEvents,
    hasNewerEvents: options.hasNewerEvents,
    usedAt: Date.now(),
    bytes: eventWindowStats(events).bytes,
  }
  entries.set(sessionID, entry)
  evictOldEntries()
  return snapshotFromEntry(entry)
}

function snapshotFromEntry(entry: ClientSessionEventEntry): ClientSessionEventSnapshot {
  return {
    events: entry.events,
    lastSeq: entry.lastSeq,
    oldestSeq: entry.oldestSeq,
    hasOlderEvents: entry.hasOlderEvents,
    hasNewerEvents: entry.hasNewerEvents,
  }
}

function firstSeq(events: AgentEvent[]) {
  return events.reduce((min, event) => (min === 0 ? event.seq : Math.min(min, event.seq)), 0)
}

function evictOldEntries() {
  const oldestFirst = [...entries.entries()].sort((left, right) => left[1].usedAt - right[1].usedAt)
  let totalBytes = oldestFirst.reduce((total, [, entry]) => total + entry.bytes, 0)
  for (const [sessionID, entry] of oldestFirst) {
    if (totalBytes <= memoryEventBytesLimit && entries.size <= memoryEventEntryLimit) break
    entries.delete(sessionID)
    totalBytes -= entry.bytes
  }
}
