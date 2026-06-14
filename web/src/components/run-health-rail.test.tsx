import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentEvent, Session } from '@/lib/api'
import { RunHealthRail } from '@/components/run-health-rail'

const session: Session = {
  id: 'sess_1',
  title: 'Inspect repo',
  agent_type: 'fake',
  status: 'running',
  created_at: '2026-06-12T16:00:00Z',
  updated_at: '2026-06-12T16:01:00Z',
  completed_at: null,
}

test('run health rail shows session context, metrics, and view control', async () => {
  const user = userEvent.setup()
  const onMessageViewChange = vi.fn()
  const onUpdateTitle = vi.fn(async () => undefined)

  render(
    <RunHealthRail
      session={session}
      events={[
        event(1, 'user.message.completed', 'user', 'completed', { text: 'Run checks' }),
        event(2, 'tool.call.started', 'assistant', 'started', { item_id: 'tool_1', command: 'bun test' }),
        event(3, 'tool.call.completed', 'assistant', 'completed', { item_id: 'tool_1', output: 'ok' }),
        event(4, 'agent.message.completed', 'assistant', 'completed', { text: 'Done' }),
      ]}
      streamState="connected"
      streamError=""
      notice=""
      messageView="chat"
      onMessageViewChange={onMessageViewChange}
      onUpdateTitle={onUpdateTitle}
    />,
  )

  expect(screen.queryByText('Session')).not.toBeInTheDocument()
  expect(screen.getByText('Inspect repo')).toBeInTheDocument()
  expect(screen.getByText('Running')).toBeInTheDocument()
  expect(screen.getByText('fake')).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'chat' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('tab', { name: 'debug' })).toHaveAttribute('aria-selected', 'false')
  expect(screen.getByText('Events')).toBeInTheDocument()
  expect(screen.getByText('Tools')).toBeInTheDocument()
  expect(screen.getByText('Agent message')).toBeInTheDocument()
  expect(screen.getByText('Live')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /refresh/i })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /cancel run/i })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /theme/i })).not.toBeInTheDocument()

  await user.click(screen.getByRole('tab', { name: 'debug' }))

  expect(onMessageViewChange).toHaveBeenCalledWith('debug')
  expect(onUpdateTitle).not.toHaveBeenCalled()
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
