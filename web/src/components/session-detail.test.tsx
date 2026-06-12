import { render, screen } from '@testing-library/react'
import type { Session } from '@/lib/api'
import { SessionDetail } from '@/components/session-detail'

const baseSession: Session = {
  id: 'sess_1',
  title: 'Inspect repo',
  agent_type: 'fake',
  status: 'idle',
  created_at: '2026-06-12T16:00:00Z',
  updated_at: '2026-06-12T16:00:00Z',
  completed_at: null,
}

test('cancel button is visible only while running', () => {
  const { rerender } = render(
    <SessionDetail
      session={baseSession}
      events={[]}
      streamState="connected"
      streamError=""
      notice=""
      onSubmitPrompt={async () => undefined}
      onCancel={async () => undefined}
      onRefresh={() => undefined}
      onUpdateTitle={async () => undefined}
    />,
  )

  expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument()

  rerender(
    <SessionDetail
      session={{ ...baseSession, status: 'running' }}
      events={[]}
      streamState="connected"
      streamError=""
      notice=""
      onSubmitPrompt={async () => undefined}
      onCancel={async () => undefined}
      onRefresh={() => undefined}
      onUpdateTitle={async () => undefined}
    />,
  )

  expect(screen.getByRole('button', { name: /cancel running session/i })).toBeInTheDocument()
})
