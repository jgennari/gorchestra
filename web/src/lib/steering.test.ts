import { activeRunID, activeThinking, eventLabel } from '@/lib/events'
import { submitMessage, type AgentEvent } from '@/lib/api'

const event = (seq: number, type: string, payload: unknown): AgentEvent => ({ id: String(seq), session_id: 's', seq, type, payload, role: 'assistant', status: 'started', created_at: '2026-09-09T12:00:00Z' })

test('run target survives truncated history, ignores late acknowledgements and clears on completion', () => {
  const events = [event(10, 'agent.thinking.started', { run_id: 'run2' }), event(11, 'user.message.completed', { delivery: 'steer', run_id: 'run1' })]
  expect(activeRunID(events)).toBe('run2')
  expect(activeThinking(events)).toBe(true)
  expect(activeRunID([...events, event(12, 'agent.run.completed', { run_id: 'run2' })])).toBe('')
  expect(activeRunID([])).toBe('')
  expect(eventLabel('user.message.steer.submitted')).toBe('Sending now')
  expect(eventLabel('user.message.steer.failed')).toBe('Send now not confirmed')
})

test('steering request carries its immutable run and submission identities', async () => {
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toEqual({ content: 'New direction', client_submission_id: 'send1', steer: true, expected_run_id: 'run1' })
    return Response.json({ session_id: 's', status: 'running', accepted_as: 'steered' })
  })
  vi.stubGlobal('fetch', fetch)
  try {
    const result = await submitMessage('s', 'New direction', undefined, [], false, [], 'send1', 'run1')
    expect(result.accepted_as).toBe('steered')
    expect(fetch).toHaveBeenCalledOnce()
  } finally { vi.unstubAllGlobals() }
})
