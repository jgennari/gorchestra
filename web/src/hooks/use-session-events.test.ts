import { act, renderHook, waitFor } from '@testing-library/react'
import type { AgentEvent } from '@/lib/api'
import {
  clearSessionEventCacheForTest,
  invalidateSessionEventTails,
  listAdaptiveRecentEventTurns,
  trimEventsToRecentTurnBudget,
  trimEventsToRecentTurns,
  useSessionEvents,
} from '@/hooks/use-session-events'
import { readCachedSessionEvents, writeCachedSessionEvents } from '@/lib/session-cache'
import { createFakeIndexedDB } from '@/test/fake-indexeddb'
import { ingestClientEvent, publishClientSessionEvent } from '@/lib/client-event-store'
import { pendingUserInputRequest } from '@/lib/events'

test('question controls survive a truncated transcript and resolve from the shared stream', async () => {
  clearSessionEventCacheForTest()
  const request = { ...event(2, 'agent.input.requested'), payload: { request_id: 'question', delivery: 'async', questions: [{ id: 'q', question: 'Choose?', is_other: true, options: [] }] } }
  const fetchMock = vi.fn(async () => jsonResponse({
    events: [event(10000, 'agent.thinking.started')],
    input_events: [request],
    page: { ...historyPage(10000, 10000, true), server_last_seq: 10000 },
  }))
  vi.stubGlobal('fetch', fetchMock)
  const { result, unmount } = renderHook(() => useSessionEvents('sess_test', { liveStreamState: 'connected' }))
  await waitFor(() => expect(result.current.streamState).toBe('connected'))
  expect(result.current.events.map(event => event.seq)).toEqual([10000])
  expect(pendingUserInputRequest(result.current.liveEvents)?.requestID).toBe('question')
  unmount()
  const second = renderHook(() => useSessionEvents('sess_test', { liveStreamState: 'connected' }))
  await waitFor(() => expect(pendingUserInputRequest(second.result.current.liveEvents)?.requestID).toBe('question'))
  expect(fetchMock).toHaveBeenCalledTimes(1)
  act(() => ingestClientEvent({ ...event(10001, 'agent.input.answered'), payload: { request_id: 'question', delivery: 'async' } }))
  await waitFor(() => expect(pendingUserInputRequest(second.result.current.liveEvents)).toBeNull())
  second.unmount()
  vi.unstubAllGlobals()
})

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

test('warm reload paints slow persistent history, then catches up even when SSE is connected', async () => {
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
  let resolveHistory!: (response: Response) => void
  const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveHistory = resolve }))
  vi.stubGlobal('fetch', fetchMock)

  const { result, unmount } = renderHook(() => useSessionEvents('sess_1', { liveStreamState: 'connected' }))

  await waitFor(() => expect(result.current.events.map((item) => item.seq)).toEqual([10, 11]), {
    timeout: 3000,
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(result.current.streamState).toBe('loading')
  await act(async () => resolveHistory(jsonResponse({
    events: [event(10, 'user.message.completed'), event(11, 'agent.message.completed'), event(12, 'agent.message.completed')],
    page: { ...historyPage(10, 12, true), server_last_seq: 12 },
  })))
  expect(result.current.events.map((item) => item.seq)).toEqual([10, 11, 12])
  expect(result.current.streamState).toBe('connected')

  unmount()
  vi.unstubAllGlobals()
})

test('offline session hydration reads persistent history without requesting the server', async () => {
  const fakeIndexedDB = createFakeIndexedDB()
  vi.stubGlobal('indexedDB', fakeIndexedDB)
  clearSessionEventCacheForTest()
  await writeCachedSessionEvents(
    'sess_offline',
    [
      { ...event(20, 'user.message.completed'), session_id: 'sess_offline' },
      { ...event(21, 'agent.message.completed'), session_id: 'sess_offline' },
    ],
    true,
  )
  clearSessionEventCacheForTest()
  const fetchMock = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))
  vi.stubGlobal('fetch', fetchMock)

  const { result, unmount } = renderHook(() =>
    useSessionEvents('sess_offline', { networkAvailable: false }),
  )

  await waitFor(() => expect(result.current.events.map((item) => item.seq)).toEqual([20, 21]))
  expect(result.current.streamState).toBe('disconnected')
  expect(fetchMock).not.toHaveBeenCalled()
  await act(async () => { await result.current.loadOlderEvents() })
  expect(result.current.olderHistoryUnavailable).toBe(true)
  expect(result.current.events.map((item) => item.seq)).toEqual([20, 21])
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

test('the shared activity store delivers durable events without opening another stream', async () => {
  clearSessionEventCacheForTest()
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path === '/api/sessions/sess_test/events?tail=true&turns=50&max_bytes=2097152') {
      return jsonResponse({
        events: [event(1, 'user.message.completed')],
        page: { ...historyPage(1, 1, false), server_last_seq: 1 },
      })
    }
    throw new Error(`unexpected URL ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const { result, unmount } = renderHook(() => useSessionEvents('sess_test'))
  await waitFor(() => expect(result.current.events.map((item) => item.seq)).toEqual([1]))
  act(() => {
    ingestClientEvent(event(2, 'agent.message.completed'))
  })

  await waitFor(() => expect(result.current.events.map((item) => item.seq)).toEqual([1, 2]))
  expect(HookEventSource.instances).toHaveLength(0)
  expect(fetchMock).toHaveBeenCalledTimes(1)

  unmount()
  vi.unstubAllGlobals()
})

test('a sparse background activity window is painted immediately and then hydrated from the server tail', async () => {
  clearSessionEventCacheForTest()
  ingestClientEvent(event(8, 'agent.message.completed'))
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path === '/api/sessions/sess_test/events?tail=true&turns=50&max_bytes=2097152') {
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
    throw new Error(`unexpected URL ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const { result, unmount } = renderHook(() => useSessionEvents('sess_test'))

  expect(result.current.events.map((item) => item.seq)).toEqual([8])
  await waitFor(() => expect(result.current.events.map((item) => item.seq)).toEqual([5, 6, 7, 8]))
  expect(fetchMock).toHaveBeenCalledTimes(1)

  unmount()
  vi.unstubAllGlobals()
})

test('a reload persists the durable cursor but not a multiplexed transient delta', async () => {
  vi.stubGlobal('indexedDB', createFakeIndexedDB())
  clearSessionEventCacheForTest()
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path === '/api/sessions/sess_test/events?tail=true&turns=50&max_bytes=2097152') {
      return jsonResponse({
        events: [event(1, 'user.message.completed')],
        page: { ...historyPage(1, 1, false), server_last_seq: 1 },
      })
    }
    throw new Error(`unexpected URL ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const first = renderHook(() => useSessionEvents('sess_test'))
  await waitFor(() => expect(first.result.current.events.map((item) => item.seq)).toEqual([1]))
  act(() => publishClientSessionEvent(event(2, 'agent.message.delta')))
  await waitFor(() => expect(first.result.current.events.map((item) => item.seq)).toEqual([1, 2]))
  first.unmount()

  const persisted = await readCachedSessionEvents('sess_test')
  expect(persisted?.lastSeq).toBe(1)
  expect(persisted?.events.map((item) => item.seq)).toEqual([1])

  clearSessionEventCacheForTest()
  const second = renderHook(() => useSessionEvents('sess_test'))
  await waitFor(() => expect(second.result.current.events.map((item) => item.seq)).toEqual([1]))
  await waitFor(() => expect(second.result.current.streamState).toBe('connected'))
  expect(fetchMock).toHaveBeenCalledTimes(2)

  second.unmount()
  vi.unstubAllGlobals()
})

test('selected history reports the browser-wide stream state', async () => {
  clearSessionEventCacheForTest()
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path === '/api/sessions/sess_test/events?tail=true&turns=50&max_bytes=2097152') {
      return jsonResponse({
        events: [event(1, 'agent.message.completed')],
        page: { ...historyPage(1, 1, false), server_last_seq: 1 },
      })
    }
    throw new Error(`unexpected URL ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const initialProps: { liveStreamState: 'connected' | 'reconnecting' } = { liveStreamState: 'connected' }
  const { result, rerender, unmount } = renderHook(
    ({ liveStreamState }: { liveStreamState: 'connected' | 'reconnecting' }) =>
      useSessionEvents('sess_test', { liveStreamState }),
    { initialProps },
  )
  await waitFor(() => expect(result.current.streamState).toBe('connected'))
  rerender({ liveStreamState: 'reconnecting' })
  expect(result.current.streamState).toBe('reconnecting')
  expect(HookEventSource.instances).toHaveLength(0)

  unmount()
  vi.unstubAllGlobals()
})

test('jumping to the live tail reuses the connected global stream window', async () => {
  clearSessionEventCacheForTest()
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path === '/api/sessions/sess_test/events?tail=true&turns=50&max_bytes=2097152') {
      return jsonResponse({
        events: [event(1, 'user.message.completed')],
        page: { ...historyPage(1, 1, false), server_last_seq: 1 },
      })
    }
    throw new Error(`unexpected URL ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const { result, unmount } = renderHook(() =>
    useSessionEvents('sess_test', { liveStreamState: 'connected' }),
  )
  await waitFor(() => expect(result.current.events.map((item) => item.seq)).toEqual([1]))

  act(() => result.current.setFollowingTail(false))
  act(() => ingestClientEvent(event(2, 'agent.message.completed')))
  await waitFor(() => expect(result.current.hasNewerEvents).toBe(true))
  await act(async () => result.current.jumpToLatest())

  expect(result.current.events.map((item) => item.seq)).toEqual([1, 2])
  expect(result.current.hasNewerEvents).toBe(false)
  expect(fetchMock).toHaveBeenCalledTimes(1)

  unmount()
  vi.unstubAllGlobals()
})

test('resync preserves a historical view while repairing the live tail and merging racing events once', async () => {
  clearSessionEventCacheForTest()
  const initial = [event(1, 'user.message.completed'), event(2, 'agent.message.completed')]
  let resolveRecovery!: (response: Response) => void
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ events: initial, page: { ...historyPage(1, 2, false), server_last_seq: 2 } }))
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveRecovery = resolve }))
  vi.stubGlobal('fetch', fetchMock)
  const { result, rerender, unmount } = renderHook(
    ({ historySyncKey }) => useSessionEvents('sess_test', { historySyncKey, liveStreamState: 'connected' }),
    { initialProps: { historySyncKey: 0 } },
  )
  await waitFor(() => expect(result.current.streamState).toBe('connected'))
  act(() => result.current.setFollowingTail(false))
  invalidateSessionEventTails()
  rerender({ historySyncKey: 1 })
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  act(() => ingestClientEvent(event(4, 'agent.message.completed')))
  await act(async () => resolveRecovery(jsonResponse({
    events: [...initial, event(3, 'agent.message.completed')],
    page: { ...historyPage(1, 3, false), server_last_seq: 3 },
  })))
  expect(result.current.events.map((item) => item.seq)).toEqual([1, 2])
  expect(result.current.liveEvents.map((item) => item.seq)).toEqual([1, 2, 3, 4])
  expect(result.current.hasNewerEvents).toBe(true)
  await act(async () => result.current.jumpToLatest())
  expect(result.current.events.map((item) => item.seq)).toEqual([1, 2, 3, 4])
  expect(fetchMock).toHaveBeenCalledTimes(2)
  unmount()
  vi.unstubAllGlobals()
})

test('failed catch-up keeps cached history and Jump to latest retries despite a connected SSE', async () => {
  clearSessionEventCacheForTest()
  const initial = [event(1, 'user.message.completed')]
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ events: initial }))
    .mockRejectedValueOnce(new Error('Catch-up failed'))
    .mockResolvedValueOnce(jsonResponse({ events: [...initial, event(2, 'agent.message.completed')] }))
  vi.stubGlobal('fetch', fetchMock)
  const { result, rerender, unmount } = renderHook(
    ({ historySyncKey }) => useSessionEvents('sess_test', { historySyncKey, liveStreamState: 'connected' }),
    { initialProps: { historySyncKey: 0 } },
  )
  await waitFor(() => expect(result.current.streamState).toBe('connected'))
  invalidateSessionEventTails()
  rerender({ historySyncKey: 1 })
  await waitFor(() => expect(result.current.error).toBe('Catch-up failed'))
  expect(result.current.events.map((item) => item.seq)).toEqual([1])
  await act(async () => result.current.jumpToLatest())
  expect(result.current.events.map((item) => item.seq)).toEqual([1, 2])
  expect(fetchMock).toHaveBeenCalledTimes(3)
  unmount()
  vi.unstubAllGlobals()
})

test('a large catch-up gap uses a contiguous server tail and leaves the gap reachable by paging backward', async () => {
  clearSessionEventCacheForTest()
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ events: [event(1, 'user.message.completed'), event(2, 'agent.message.completed')] }))
    .mockResolvedValueOnce(jsonResponse({
      events: [event(100, 'user.message.completed'), event(101, 'agent.message.completed')],
      page: historyPage(100, 101, true),
    }))
    .mockResolvedValueOnce(jsonResponse({ events: [event(98, 'user.message.completed'), event(99, 'agent.message.completed')] }))
  vi.stubGlobal('fetch', fetchMock)
  const { result, rerender, unmount } = renderHook(
    ({ historySyncKey }) => useSessionEvents('sess_test', { historySyncKey, liveStreamState: 'connected' }),
    { initialProps: { historySyncKey: 0 } },
  )
  await waitFor(() => expect(result.current.streamState).toBe('connected'))
  act(() => result.current.setFollowingTail(false))
  invalidateSessionEventTails()
  rerender({ historySyncKey: 1 })
  await waitFor(() => expect(result.current.liveEvents.map((item) => item.seq)).toEqual([100, 101]))
  expect(result.current.events.map((item) => item.seq)).toEqual([1, 2])
  await act(async () => result.current.jumpToLatest())
  expect(result.current.events.map((item) => item.seq)).toEqual([100, 101])
  await act(async () => result.current.loadOlderEvents())
  expect(String(fetchMock.mock.calls[2][0])).toContain('before_seq=100')
  expect(result.current.events.map((item) => item.seq)).toEqual([98, 99, 100, 101])
  unmount()
  vi.unstubAllGlobals()
})

test('a history response started before resync cannot replace the recovered tail', async () => {
  clearSessionEventCacheForTest()
  let resolveOld!: (response: Response) => void
  const fetchMock = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve }))
    .mockResolvedValueOnce(jsonResponse({ events: [event(20, 'user.message.completed'), event(21, 'agent.message.completed')] }))
  vi.stubGlobal('fetch', fetchMock)
  const { result, rerender, unmount } = renderHook(
    ({ historySyncKey }) => useSessionEvents('sess_test', { historySyncKey }),
    { initialProps: { historySyncKey: 0 } },
  )
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  invalidateSessionEventTails()
  rerender({ historySyncKey: 1 })
  await waitFor(() => expect(result.current.events.map((item) => item.seq)).toEqual([20, 21]))
  await act(async () => resolveOld(jsonResponse({ events: [event(1, 'user.message.completed')] })))
  expect(result.current.events.map((item) => item.seq)).toEqual([20, 21])
  expect(fetchMock).toHaveBeenCalledTimes(2)
  unmount()
  vi.unstubAllGlobals()
})

test('a cached historical link loads its target after bootstrap and stays focused across resync', async () => {
  clearSessionEventCacheForTest()
  vi.stubGlobal('indexedDB', createFakeIndexedDB())
  await writeCachedSessionEvents('sess_test', [event(100, 'user.message.completed')], true)
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => String(url).includes('around_seq=10')
    ? jsonResponse({ events: [event(10, 'user.message.completed')], page: historyPage(10, 10, true, true) })
    : jsonResponse({ events: [event(100, 'user.message.completed'), event(101, 'agent.message.completed')] }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const { result, rerender, unmount } = renderHook(
    ({ historyReady, historySyncKey }) => useSessionEvents('sess_test', { historyReady, historySyncKey, targetSeq: 10 }),
    { initialProps: { historyReady: false, historySyncKey: 0 } },
  )
  await waitFor(() => expect(result.current.events.map((item) => item.seq)).toEqual([100]))
  expect(fetchMock).not.toHaveBeenCalled()
  invalidateSessionEventTails()
  rerender({ historyReady: true, historySyncKey: 1 })
  await waitFor(() => expect(result.current.events.map((item) => item.seq)).toEqual([10]))
  invalidateSessionEventTails()
  rerender({ historyReady: true, historySyncKey: 2 })
  await waitFor(() => expect(result.current.streamState).toBe('connected'))
  expect(result.current.events.map((item) => item.seq)).toEqual([10])
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('around_seq=10'))).toHaveLength(1)
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('tail=true'))).toHaveLength(2)
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
  static instances: HookEventSource[] = []

  url: string
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  private listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>()

  constructor(url: string) {
    this.url = url
    HookEventSource.instances.push(this)
    window.setTimeout(() => this.onopen?.(new Event('open')), 0)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add((event) => {
      if (typeof listener === 'function') listener(event)
      else listener.handleEvent(event)
    })
    this.listeners.set(type, listeners)
  }

  emit(value: AgentEvent) {
    this.dispatch(value.type, value)
  }

  emitControl(type: string) {
    this.dispatch(type, {})
  }

  fail() {
    this.onerror?.(new Event('error'))
  }

  private dispatch(type: string, value: unknown) {
    const message = new MessageEvent(type, { data: JSON.stringify(value) })
    for (const listener of this.listeners.get(type) ?? []) listener(message)
  }

  close() {}
}
