import type { AgentEvent, EventHistoryResponse } from '@/lib/api'
import { reconcileInputEvents, unresolvedInputEvents } from '@/lib/input-events'
import { isTransientEvent, lastSeq } from '@/lib/events'
import {
  appendBoundedEvent,
  boundEventWindow,
  eventWindowStats,
  mergeBoundedEvents,
} from '@/lib/session-event-window'
import { writeCachedSessionEvent as writePersistentCachedSessionEvent } from '@/lib/session-cache'

export type ClientSessionEventSnapshot = {
  events: AgentEvent[]
  inputEvents?: AgentEvent[]
  lastSeq: number
  oldestSeq: number
  hasOlderEvents: boolean
  hasNewerEvents: boolean
  tailHydrated: boolean
}

type ClientSessionEventEntry = ClientSessionEventSnapshot & {
  usedAt: number
  bytes: number
}

type SessionEventListener = (event: AgentEvent | null, snapshot: ClientSessionEventSnapshot) => void

const memoryEventBytesLimit = 32 * 1024 * 1024
const memoryEventEntryLimit = 50
const sharedEventWindowPolicy = {
  maxTurns: 50,
  maxDurableEvents: 1000,
  // The server caps live payloads at 8 MiB; the extra MiB covers event JSON.
  maxBytes: 9 * 1024 * 1024,
  maxTransientEvents: 200,
  maxTransientBytes: 9 * 1024 * 1024,
} as const
const entries = new Map<string, ClientSessionEventEntry>()
const cursors = new Map<string, number>()
const liveSnapshotCursors = new Map<string, number>()
const listeners = new Map<string, Set<SessionEventListener>>()

export function ingestClientEvent(event: AgentEvent) {
  if (!event.session_id) return false

  if (isTransientEvent(event)) {
    if (event.seq <= (liveSnapshotCursors.get(event.session_id) ?? 0)) return false
    const current = entries.get(event.session_id)
    if (current?.events.some((existing) => existing.id === event.id || existing.seq === event.seq)) return false
    const bounded = appendBoundedEvent(current?.events ?? [], event, sharedEventWindowPolicy)
    const snapshot = setEntry(event.session_id, bounded.events, {
      inputEvents: current?.inputEvents,
      lastSeq: current?.lastSeq ?? cursors.get(event.session_id) ?? 0,
      hasOlderEvents: Boolean(current?.hasOlderEvents) || bounded.trimmedStart,
      hasNewerEvents: false,
      tailHydrated: current?.tailHydrated === true,
    })
    for (const listener of listeners.get(event.session_id) ?? []) listener(event, snapshot)
    return true
  }

  const cursor = cursors.get(event.session_id) ?? 0
  if (event.seq <= cursor) return false

  const current = entries.get(event.session_id)
  const bounded = appendBoundedEvent(current?.events ?? [], event, sharedEventWindowPolicy)
  const snapshot = setEntry(event.session_id, bounded.events, {
    inputEvents: unresolvedInputEvents([...(current?.inputEvents ?? []), event]),
    lastSeq: event.seq,
    hasOlderEvents: Boolean(current?.hasOlderEvents) || bounded.trimmedStart || firstSeq(bounded.events) > 1,
    hasNewerEvents: false,
    tailHydrated: current?.tailHydrated === true,
  })
  cursors.set(event.session_id, event.seq)
  void writePersistentCachedSessionEvent(event.session_id, event, event.seq)

  for (const listener of listeners.get(event.session_id) ?? []) {
    listener(event, snapshot)
  }
  return true
}

export function replaceClientLiveEvents(events: AgentEvent[], watermarks: Record<string, number> = {}) {
  const liveBySession = new Map<string, AgentEvent[]>()
  for (const event of events) {
    if (!event.session_id || !isTransientEvent(event)) continue
    const sessionEvents = liveBySession.get(event.session_id) ?? []
    sessionEvents.push(event)
    liveBySession.set(event.session_id, sessionEvents)
  }

  const sessionIDs = new Set([...entries.keys(), ...liveBySession.keys()])
  for (const [sessionID, seq] of Object.entries(watermarks)) {
    liveSnapshotCursors.set(sessionID, Math.max(liveSnapshotCursors.get(sessionID) ?? 0, seq))
    sessionIDs.add(sessionID)
  }
  for (const sessionID of sessionIDs) {
    const current = entries.get(sessionID)
    const durable = (current?.events ?? []).filter((event) => !isTransientEvent(event))
    const bounded = boundEventWindow([...durable, ...(liveBySession.get(sessionID) ?? [])], 'latest', sharedEventWindowPolicy)
    if (!current && bounded.events.length === 0) continue
    const snapshot = setEntry(sessionID, bounded.events, {
      inputEvents: current?.inputEvents,
      lastSeq: current?.lastSeq ?? cursors.get(sessionID) ?? 0,
      hasOlderEvents: Boolean(current?.hasOlderEvents) || bounded.trimmedStart,
      hasNewerEvents: false,
      tailHydrated: current?.tailHydrated === true,
    })
    for (const listener of listeners.get(sessionID) ?? []) listener(null, snapshot)
  }
}

export function replaceClientSessionLiveEvents(sessionID: string, events: AgentEvent[], watermark: number) {
  const current = entries.get(sessionID)
  const retained = (current?.events ?? []).filter((event) =>
    !isTransientEvent(event) || event.seq > watermark,
  )
  const snapshotLive = events.filter((event) => event.session_id === sessionID && isTransientEvent(event))
  const combined = [...retained.filter((event) => !isTransientEvent(event)), ...snapshotLive]
  for (const event of retained.filter((event) => isTransientEvent(event)).sort((left, right) => left.seq - right.seq)) {
    const next = appendBoundedEvent(combined, event, sharedEventWindowPolicy)
    combined.splice(0, combined.length, ...next.events)
  }
  liveSnapshotCursors.set(sessionID, Math.max(liveSnapshotCursors.get(sessionID) ?? 0, watermark))
  const bounded = boundEventWindow(combined, 'latest', sharedEventWindowPolicy)
  if (!current && bounded.events.length === 0) return
  const snapshot = setEntry(sessionID, bounded.events, {
    inputEvents: current?.inputEvents,
    lastSeq: current?.lastSeq ?? cursors.get(sessionID) ?? 0,
    hasOlderEvents: Boolean(current?.hasOlderEvents) || bounded.trimmedStart,
    hasNewerEvents: false,
    tailHydrated: current?.tailHydrated === true,
  })
  for (const listener of listeners.get(sessionID) ?? []) listener(null, snapshot)
}

// Selected-session provider diagnostics that must not enter the normal durable
// cache still use the same listener path.
export function publishClientSessionEvent(event: AgentEvent) {
  if (!event.session_id) return false
  const snapshot = readClientSessionEvents(event.session_id) ?? emptySnapshot()
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
    tailHydrated?: boolean
    replace?: boolean
    inputHistory?: EventHistoryResponse
  } = {},
) {
  const durableEvents = events.filter((event) => !isTransientEvent(event))
  const current = entries.get(sessionID)
  const bounded = options.replace
    ? boundEventWindow(events, 'latest', sharedEventWindowPolicy)
    : mergeBoundedEvents(current?.events ?? [], events, 'latest', sharedEventWindowPolicy)
  const cursor = Math.max(cursors.get(sessionID) ?? 0, options.lastSeq ?? 0, lastSeq(durableEvents))
  cursors.set(sessionID, cursor)
  return setEntry(sessionID, bounded.events, {
    inputEvents: options.inputHistory
      ? reconcileInputEvents(current?.inputEvents ?? [], options.inputHistory)
      : unresolvedInputEvents([...(current?.inputEvents ?? []), ...durableEvents]),
    lastSeq: cursor,
    hasOlderEvents:
      options.hasOlderEvents === true ||
      (options.replace ? false : current?.hasOlderEvents === true) ||
      bounded.trimmedStart ||
      firstSeq(bounded.events) > 1,
    hasNewerEvents: options.hasNewerEvents ?? (options.replace ? false : current?.hasNewerEvents ?? false),
    tailHydrated: options.tailHydrated ?? (options.replace ? false : current?.tailHydrated ?? false),
  })
}

export function readClientSessionEvents(sessionID: string): ClientSessionEventSnapshot | null {
  const entry = entries.get(sessionID)
  if (!entry) return null
  entry.usedAt = Date.now()
  return snapshotFromEntry(entry)
}

// Keep the cached paint, but stop treating it as a complete live tail after
// adopting a new stream boundary. Background sessions reconcile when selected.
export function invalidateClientSessionEventTails() {
  for (const entry of entries.values()) entry.tailHydrated = false
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
  liveSnapshotCursors.clear()
  listeners.clear()
}

function setEntry(
  sessionID: string,
  events: AgentEvent[],
  options: Pick<
    ClientSessionEventSnapshot,
    'lastSeq' | 'hasOlderEvents' | 'hasNewerEvents' | 'tailHydrated' | 'inputEvents'
  >,
) {
  const entry: ClientSessionEventEntry = {
    events,
    inputEvents: options.inputEvents,
    lastSeq: Math.max(options.lastSeq, lastSeq(events.filter((event) => !isTransientEvent(event)))),
    oldestSeq: firstSeq(events),
    hasOlderEvents: options.hasOlderEvents,
    hasNewerEvents: options.hasNewerEvents,
    tailHydrated: options.tailHydrated,
    usedAt: Date.now(),
    bytes: eventWindowStats(events).bytes + eventWindowStats(options.inputEvents ?? []).bytes,
  }
  entries.set(sessionID, entry)
  evictOldEntries()
  return snapshotFromEntry(entry)
}

function snapshotFromEntry(entry: ClientSessionEventEntry): ClientSessionEventSnapshot {
  return {
    events: entry.events,
    inputEvents: entry.inputEvents,
    lastSeq: entry.lastSeq,
    oldestSeq: entry.oldestSeq,
    hasOlderEvents: entry.hasOlderEvents,
    hasNewerEvents: entry.hasNewerEvents,
    tailHydrated: entry.tailHydrated,
  }
}

function emptySnapshot(): ClientSessionEventSnapshot {
  return {
    events: [],
    lastSeq: 0,
    oldestSeq: 0,
    hasOlderEvents: false,
    hasNewerEvents: false,
    tailHydrated: false,
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
