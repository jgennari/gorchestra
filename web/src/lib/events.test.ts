import type { AgentEvent } from '@/lib/api'
import { appendEvent, appendEvents, coalesceDisplayEvents, lastSeq } from '@/lib/events'

function event(seq: number, type = 'agent.message.delta', text = `event ${seq}`): AgentEvent {
  return {
    id: `evt_${seq}`,
    session_id: 'sess_test',
    seq,
    type,
    role: 'assistant',
    status: 'delta',
    payload: { text },
    created_at: '2026-06-12T16:00:00Z',
  }
}

test('event reducer appends events in sequence order', () => {
  const events = appendEvents([], [event(3), event(1), event(2)])

  expect(events.map((item) => item.seq)).toEqual([1, 2, 3])
  expect(lastSeq(events)).toBe(3)
})

test('event reducer dedupes by sequence', () => {
  const events = appendEvent([event(1, 'agent.message.delta', 'first')], event(1, 'agent.message.delta', 'second'))

  expect(events).toHaveLength(1)
  expect(events[0].payload).toEqual({ text: 'first' })
})

test('display events coalesce consecutive agent deltas', () => {
  const events = coalesceDisplayEvents([
    event(1, 'agent.message.delta', 'Hello'),
    event(2, 'agent.message.delta', ' world'),
    event(3, 'agent.run.completed', ''),
  ])

  expect(events).toHaveLength(2)
  expect(events[0].payload).toEqual({ text: 'Hello world' })
})
