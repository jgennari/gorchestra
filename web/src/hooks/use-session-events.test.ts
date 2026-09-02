import { act, renderHook, waitFor } from '@testing-library/react'
import type { AgentEvent } from '@/lib/api'
import {
  clearSessionEventCacheForTest,
  listAdaptiveRecentEventTurns,
  trimEventsToRecentTurnBudget,
  trimEventsToRecentTurns,
  useSessionEvents,
} from '@/hooks/use-session-events'
import { writeCachedSessionEvents } from '@/lib/session-cache'
import { createFakeIndexedDB } from '@/test/fake-indexeddb'

test('turn trimming keeps the latest requested turns', () => {
  const trimmed = trimEventsToRecentTurns(
    [
      event(1, 'user.message.completed'),
      event(2, 'agent.message.completed'),
      event(3, 'user.message.completed'),
      event(4, 'tool.call.started'),
      event(5, 'tool.call.completed'),
      event(6, 'user.message.completed'),
      event(7, 'agent.message.completed'),
    ],
    2,
  )

  expect(trimmed.map((item) => item.seq)).toEqual([3, 4, 5, 6, 7])
})

test('turn trimming preserves preamble events when fewer turns exist', () => {
  const trimmed = trimEventsToRecentTurns(
    [
      event(1, 'session.status.updated'),
      event(2, 'user.message.completed'),
      event(3, 'agent.message.completed'),
    ],
    2,
  )

  expect(trimmed.map((item) => item.seq)).toEqual([1, 2, 3])
})

test('turn trimming keeps every event in a large turn', () => {
  const largeTurn = Array.from({ length: 1200 }, (_, index) => event(index + 2, 'agent.log.delta'))
  const trimmed = trimEventsToRecentTurns(
    [event(1, 'user.message.completed'), ...largeTurn, event(1202, 'agent.message.completed')],
    2,
  )

  expect(trimmed).toHaveLength(1202)
})

test('byte-budget trimming keeps only whole recent turns', () => {
  const events = [
    event(1, 'user.message.completed'),
    event(2, 'agent.message.completed'),
    event(3, 'user.message.completed'),
    event(4, 'agent.message.completed'),
    event(5, 'user.message.completed'),
    event(6, 'agent.message.completed'),
    event(7, 'user.message.completed'),
    event(8, 'agent.message.completed'),
  ]
  const threeRecentTurns = events.slice(2)
  const budget = serializedBytes(threeRecentTurns) + 6

  const trimmed = trimEventsToRecentTurnBudget(events, budget)

  expect(trimmed.map((item) => item.seq)).toEqual([3, 4, 5, 6, 7, 8])
})

test('byte-budget trimming always keeps the newest two complete turns', () => {
  const events = [
    event(1, 'user.message.completed'),
    event(2, 'agent.message.completed'),
    event(3, 'user.message.completed'),
    event(4, 'agent.message.completed'),
    event(5, 'user.message.completed'),
    event(6, 'agent.message.completed'),
  ]

  const trimmed = trimEventsToRecentTurnBudget(events, 1)

  expect(trimmed.map((item) => item.seq)).toEqual([3, 4, 5, 6])
})

test('byte-budget trimming drops an overfetched partial leading turn', () => {
  const trimmed = trimEventsToRecentTurnBudget(
    [
      event(1, 'tool.call.completed'),
      event(2, 'agent.message.completed'),
      event(3, 'user.message.completed'),
      event(4, 'agent.message.completed'),
      event(5, 'user.message.completed'),
      event(6, 'agent.message.completed'),
    ],
    100_000,
  )

  expect(trimmed.map((item) => item.seq)).toEqual([3, 4, 5, 6])
})

test('initial history fetch asks the server for one byte-bounded whole-turn window', async () => {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path === '/api/sessions/sess_test/events?tail=true&turns=5&max_bytes=100000') {
      return jsonResponse({
        events: [
          event(1, 'user.message.completed'),
          event(2, 'agent.message.completed'),
          event(3, 'user.message.completed'),
          event(4, 'agent.message.completed'),
          event(5, 'user.message.completed'),
          event(6, 'agent.message.completed'),
          event(7, 'user.message.completed'),
          event(8, 'agent.message.completed'),
          event(9, 'user.message.completed'),
          event(10, 'agent.message.completed'),
        ],
        page: { first_seq: 1, last_seq: 10, has_older: false, has_newer: false, starts_mid_turn: false, ends_mid_turn: false },
      })
    }
    throw new Error(`unexpected URL ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const history = await listAdaptiveRecentEventTurns('sess_test', false, 100_000, 5)

  expect(history.events.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  expect(history.page?.has_older).toBe(false)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('warm reload waits for a slow persistent window instead of downloading the tail again', async () => {
  const fakeIndexedDB = createFakeIndexedDB()
  vi.stubGlobal('indexedDB', fakeIndexedDB)
  vi.stubGlobal('EventSource', HookEventSource)
  clearSessionEventCacheForTest()
  await writeCachedSessionEvents(
    'sess_1',
    [event(10, 'user.message.completed'), event(11, 'agent.message.completed')],
    true,
  )

  clearSessionEventCacheForTest()
  fakeIndexedDB.setOperationDelay(225)
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    throw new Error(`unexpected history request ${String(url)}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const { result, unmount } = renderHook(() => useSessionEvents('sess_1'))

  await waitFor(() => expect(result.current.events.map((item) => item.seq)).toEqual([10, 11]), {
    timeout: 3000,
  })
  expect(fetchMock).not.toHaveBeenCalled()

  unmount()
  vi.unstubAllGlobals()
})

test('older network pages are reused after switching away and back', async () => {
  vi.stubGlobal('indexedDB', createFakeIndexedDB())
  vi.stubGlobal('EventSource', HookEventSource)
  clearSessionEventCacheForTest()
  let olderRequests = 0
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path === '/api/sessions/sess_1/events?tail=true&turns=50&max_bytes=2097152') {
      return jsonResponse({
        events: [
          event(5, 'user.message.completed'),
          event(6, 'agent.message.completed'),
          event(7, 'user.message.completed'),
          event(8, 'agent.message.completed'),
        ],
        page: historyPage(5, 8, true),
      })
    }
    if (path === '/api/sessions/sess_2/events?tail=true&turns=50&max_bytes=2097152') {
      return jsonResponse({ events: [], page: historyPage(0, 0, false) })
    }
    if (path === '/api/sessions/sess_1/events?before_seq=5&turns=25&max_bytes=1048576') {
      olderRequests += 1
      return jsonResponse({
        events: [
          event(1, 'user.message.completed'),
          event(2, 'agent.message.completed'),
          event(3, 'user.message.completed'),
          event(4, 'agent.message.completed'),
        ],
        page: historyPage(1, 4, false, true),
      })
    }
    throw new Error(`unexpected URL ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const { result, rerender, unmount } = renderHook(
    ({ sessionID }: { sessionID: string }) => useSessionEvents(sessionID),
    { initialProps: { sessionID: 'sess_1' } },
  )
  await waitFor(() => expect(result.current.events.map((item) => item.seq)).toEqual([5, 6, 7, 8]))
  await act(async () => result.current.loadOlderEvents())
  await waitFor(() => expect(result.current.events.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]))
  expect(olderRequests).toBe(1)

  rerender({ sessionID: 'sess_2' })
  await waitFor(() => expect(result.current.events).toEqual([]))
  rerender({ sessionID: 'sess_1' })
  await waitFor(() => expect(result.current.events.map((item) => item.seq)).toEqual([5, 6, 7, 8]))
  await act(async () => result.current.loadOlderEvents())
  await waitFor(() => expect(result.current.events.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]))
  expect(olderRequests).toBe(1)

  unmount()
  vi.unstubAllGlobals()
})

function event(seq: number, type: string): AgentEvent {
  return {
    id: `evt_${seq}`,
    session_id: 'sess_test',
    seq,
    type,
    role: 'assistant',
    status: type.endsWith('.completed') ? 'completed' : 'delta',
    payload: { text: `event ${seq}` },
    created_at: '2026-06-12T16:00:00Z',
  }
}

function serializedBytes(events: AgentEvent[]) {
  const encoder = new TextEncoder()
  return events.reduce((total, item) => total + encoder.encode(JSON.stringify(item)).byteLength, 0)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function historyPage(firstSeq: number, lastSeq: number, hasOlder: boolean, hasNewer = false) {
  return {
    first_seq: firstSeq,
    last_seq: lastSeq,
    server_last_seq: Math.max(lastSeq, 8),
    has_older: hasOlder,
    has_newer: hasNewer,
    starts_mid_turn: false,
    ends_mid_turn: hasNewer,
  }
}

class HookEventSource {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string) {
    void url
    window.setTimeout(() => this.onopen?.(new Event('open')), 0)
  }

  addEventListener() {}
  close() {}
}
