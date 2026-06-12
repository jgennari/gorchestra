import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentEvent } from '@/lib/api'
import { EventStream } from '@/components/event-stream'

test('unknown provider events are collapsed with raw details available', async () => {
  const user = userEvent.setup()
  render(
    <EventStream
      events={[
        event(1, 'provider.codex.event', 'system', 'completed', {
          provider_event_type: 'thread/compacted',
          raw: { summary: 'short' },
        }),
      ]}
    />,
  )

  const toggle = screen.getByRole('button', { name: /toggle event details/i })
  expect(screen.getByText('provider.codex.event')).toBeInTheDocument()
  expect(toggle).toHaveAttribute('aria-expanded', 'false')

  await user.click(toggle)

  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText(/thread\/compacted/)).toBeInTheDocument()
})

test('failed events render expanded by default', () => {
  render(
    <EventStream
      events={[event(1, 'agent.run.failed', 'assistant', 'failed', { error: 'run failed' })]}
    />,
  )

  expect(screen.getByRole('button', { name: /toggle event details/i })).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('run failed')).toBeInTheDocument()
})

test('jump to latest appears when new events arrive while scrolled up', async () => {
  const user = userEvent.setup()
  const initialEvents = [event(1, 'agent.message.delta', 'assistant', 'delta', { text: 'one' })]
  const { rerender } = render(<EventStream events={initialEvents} />)
  const log = screen.getByRole('log')

  setScrollMetrics(log, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 })
  fireEvent.scroll(log)

  rerender(
    <EventStream
      events={[...initialEvents, event(2, 'agent.message.delta', 'assistant', 'delta', { text: ' two' })]}
    />,
  )

  const jump = screen.getByRole('button', { name: /jump to latest event/i })
  expect(jump).toBeInTheDocument()

  await user.click(jump)

  expect(log.scrollTop).toBe(1000)
  expect(screen.queryByRole('button', { name: /jump to latest event/i })).not.toBeInTheDocument()
})

function event(
  seq: number,
  type: string,
  role: string,
  status: string,
  payload: Record<string, unknown>,
): AgentEvent {
  return {
    id: `evt_${seq}`,
    session_id: 'sess_1',
    seq,
    type,
    role,
    status,
    payload,
    created_at: '2026-06-12T16:00:00Z',
  }
}

function setScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: metrics.scrollHeight })
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: metrics.clientHeight })
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    writable: true,
    value: metrics.scrollTop,
  })
}
