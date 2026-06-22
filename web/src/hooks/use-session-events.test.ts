import type { AgentEvent } from '@/lib/api'
import { safeLeadingWindowEvent, trimEventsWindow } from '@/hooks/use-session-events'

test('safe leading boundary rejects streaming deltas and completion-only tool boundaries', () => {
  expect(safeLeadingWindowEvent(event(1, 'agent.message.delta'))).toBe(false)
  expect(safeLeadingWindowEvent(event(2, 'tool.call.completed'))).toBe(false)
  expect(safeLeadingWindowEvent(event(3, 'agent.message.completed'))).toBe(true)
  expect(safeLeadingWindowEvent(event(4, 'tool.call.started'))).toBe(true)
})

test('window trimming keeps the requested suffix when the boundary is already safe', () => {
  const trimmed = trimEventsWindow(
    [event(1, 'user.message.completed'), event(2, 'agent.message.completed'), event(3, 'agent.run.completed')],
    2,
  )

  expect(trimmed.map((item) => item.seq)).toEqual([2, 3])
})

test('window trimming skips forward to the next safe boundary instead of keeping a partial message', () => {
  const trimmed = trimEventsWindow(
    [
      event(1, 'user.message.completed'),
      event(2, 'agent.message.delta'),
      event(3, 'agent.message.completed'),
      event(4, 'agent.run.completed'),
    ],
    3,
  )

  expect(trimmed.map((item) => item.seq)).toEqual([3, 4])
})

test('window trimming drops incomplete tool rows when the limit would start on completion only', () => {
  const trimmed = trimEventsWindow(
    [event(1, 'tool.call.started'), event(2, 'tool.call.completed'), event(3, 'agent.message.completed')],
    2,
  )

  expect(trimmed.map((item) => item.seq)).toEqual([3])
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
