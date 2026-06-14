import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  const onCancel = vi.fn(async () => undefined)
  const { rerender } = render(
    <SessionDetail
      session={baseSession}
      events={[]}
      streamState="connected"
      streamError=""
      notice=""
      onSubmitPrompt={async () => undefined}
      onCancel={onCancel}
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
      onCancel={onCancel}
      onRefresh={() => undefined}
      onUpdateTitle={async () => undefined}
    />,
  )

  expect(screen.getByRole('button', { name: /cancel running session/i })).toBeInTheDocument()
})

test('prompt composer remains enabled after a completed run returns to idle', () => {
  render(
    <SessionDetail
      session={{ ...baseSession, status: 'idle' }}
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

  expect(screen.getByLabelText('Prompt')).toBeEnabled()
})

test('thinking indicator is visible only while running', () => {
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

  expect(screen.queryByRole('status', { name: /thinking/i })).not.toBeInTheDocument()

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

  expect(screen.getByRole('status', { name: /thinking/i })).toBeInTheDocument()
})

test('header shows status as a dot indicator', () => {
  render(
    <SessionDetail
      session={{ ...baseSession, status: 'failed' }}
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

  expect(screen.getByRole('img', { name: 'Session status: failed' })).toBeInTheDocument()
  expect(screen.queryByText('failed')).not.toBeInTheDocument()
})

test('header shows the agent chip without date metadata', () => {
  render(
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

  expect(screen.getByLabelText('Agent: fake')).toHaveTextContent('fake')
  expect(screen.queryByText(/Created:/)).not.toBeInTheDocument()
  expect(screen.queryByText(/Updated:/)).not.toBeInTheDocument()
  expect(screen.queryByText(/Last event:/)).not.toBeInTheDocument()
})

test('message section opens chat first and switches to debug view', async () => {
  const user = userEvent.setup()

  render(
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

  expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByText('No messages yet. Submit a prompt to start the chat.')).toBeInTheDocument()

  await user.click(screen.getByRole('tab', { name: 'Debug' }))

  expect(screen.getByRole('tab', { name: 'Debug' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByText('No events yet. Submit a prompt to start the run.')).toBeInTheDocument()
})
