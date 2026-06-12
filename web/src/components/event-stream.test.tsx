import { render, screen } from '@testing-library/react'
import { EventStream } from '@/components/event-stream'

test('event renderer handles unknown event types with raw details', () => {
  render(
    <EventStream
      events={[
        {
          id: 'evt_1',
          session_id: 'sess_1',
          seq: 1,
          type: 'provider.codex.event',
          role: 'system',
          status: 'completed',
          payload: { provider_event_type: 'thread/compacted', raw: { summary: 'short' } },
          created_at: '2026-06-12T16:00:00Z',
        },
      ]}
    />,
  )

  expect(screen.getByText('provider.codex.event')).toBeInTheDocument()
  expect(screen.getByText(/thread\/compacted/)).toBeInTheDocument()
})
