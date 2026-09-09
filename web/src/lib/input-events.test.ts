import type { AgentEvent } from '@/lib/api'
import { pendingUserInputRequest } from '@/lib/events'
import { reconcileInputEvents, unresolvedInputEvents } from '@/lib/input-events'

function event(seq: number, type: string): AgentEvent {
  return { id: `e${seq}`, session_id: 's', seq, type, role: 'assistant', status: 'completed', created_at: '', payload: { delivery: 'async', request_id: 'q', questions: [{ id: 'one', question: 'Choose?', is_other: true, options: [] }] } }
}

test('pending questions are restored independently of truncated history pages', () => {
  const request = event(2, 'agent.input.requested')
  const state = reconcileInputEvents([], { events: [event(10000, 'agent.thinking.started')], input_events: [request] })
  expect(pendingUserInputRequest(state)?.requestID).toBe('q')
  expect(unresolvedInputEvents([...state, ...Array.from({ length: 2000 }, (_, index) => event(index + 10001, 'tool.call.completed'))])).toEqual([request])
})

test('a stale snapshot cannot resurrect a question answered or closed during its request', () => {
  const request = event(2, 'agent.input.requested')
  for (const type of ['agent.input.answered', 'agent.run.completed', 'agent.run.cancelled']) {
    const current = unresolvedInputEvents([request, event(20, type)])
    const merged = reconcileInputEvents(current, { events: [event(19, 'agent.thinking.started')], input_events: [request] })
    expect(pendingUserInputRequest(merged)).toBeNull()
  }
})

test('authoritative empty snapshot clears stale controls even when browsing older transcript pages', () => {
  const request = event(2, 'agent.input.requested')
  const page = { first_seq: 2, last_seq: 2, server_last_seq: 20, has_older: false, has_newer: true, starts_mid_turn: false, ends_mid_turn: true }
  expect(reconcileInputEvents([request], { events: [request], page, input_events: [] })).toEqual([])
})
