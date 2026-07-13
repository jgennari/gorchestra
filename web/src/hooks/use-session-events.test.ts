import type { AgentEvent } from '@/lib/api'
import { trimEventsToRecentTurns } from '@/hooks/use-session-events'

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
