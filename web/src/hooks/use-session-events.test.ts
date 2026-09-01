import type { AgentEvent } from '@/lib/api'
import {
  listAdaptiveRecentEventTurns,
  trimEventsToRecentTurnBudget,
  trimEventsToRecentTurns,
} from '@/hooks/use-session-events'

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

test('adaptive history fetch expands beyond two turns when they fit the budget', async () => {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path === '/api/sessions/sess_test/events?tail=true&turns=2') {
      return jsonResponse({
        events: [
          event(7, 'user.message.completed'),
          event(8, 'agent.message.completed'),
          event(9, 'user.message.completed'),
          event(10, 'agent.message.completed'),
        ],
        page: { first_seq: 7, last_seq: 10, has_older: true, has_newer: false, starts_mid_turn: false, ends_mid_turn: false },
      })
    }
    if (path === '/api/sessions/sess_test/events?before_seq=7&turns=3') {
      return jsonResponse({
        events: [
          event(1, 'user.message.completed'),
          event(2, 'agent.message.completed'),
          event(3, 'user.message.completed'),
          event(4, 'agent.message.completed'),
          event(5, 'user.message.completed'),
          event(6, 'agent.message.completed'),
        ],
        page: { first_seq: 1, last_seq: 6, has_older: false, has_newer: true, starts_mid_turn: false, ends_mid_turn: true },
      })
    }
    throw new Error(`unexpected URL ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const history = await listAdaptiveRecentEventTurns('sess_test', false, 100_000, 5)

  expect(history.events.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  expect(history.page.has_older).toBe(false)
  expect(fetchMock).toHaveBeenCalledTimes(2)
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
