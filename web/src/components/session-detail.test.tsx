import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps, ReactNode } from 'react'
import type { AgentEvent, Session } from '@/lib/api'
import { SessionDetail } from '@/components/session-detail'

const baseSession: Session = {
  id: 'sess_1',
  title: 'Inspect repo',
  agent_type: 'fake',
  status: 'idle',
  workspace_path: '/repo',
  event_count: 0,
  tool_count: 0,
  created_at: '2026-06-12T16:00:00Z',
  updated_at: '2026-06-12T16:00:00Z',
  completed_at: null,
  archived_at: null,
}

test('cancel button is visible only while running', () => {
  const onCancel = vi.fn(async () => undefined)
  const { rerender } = renderDetail({ onCancel })

  expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument()

  rerenderDetail(rerender, { session: { ...baseSession, status: 'running' }, onCancel })

  expect(screen.getByRole('button', { name: /cancel running session/i })).toBeInTheDocument()
})

test('prompt composer remains enabled after a completed run returns to idle', () => {
  renderDetail({ session: { ...baseSession, status: 'idle' } })

  expect(screen.getByLabelText('Prompt')).toBeEnabled()
})

test('thinking indicator follows active reasoning events while running', () => {
  const { rerender } = renderDetail()

  expect(screen.queryByRole('status', { name: /thinking/i })).not.toBeInTheDocument()

  rerenderDetail(rerender, {
    session: { ...baseSession, status: 'running' },
    events: [event(1, 'agent.status.started', { provider_event_type: 'turn/started' })],
  })

  expect(screen.getByRole('status', { name: /thinking/i })).toBeInTheDocument()

  rerenderDetail(rerender, {
    session: { ...baseSession, status: 'running' },
    events: [
      event(1, 'agent.status.started', { provider_event_type: 'turn/started' }),
      event(2, 'agent.thinking.completed', {
        provider_event_type: 'item/completed',
        item_type: 'reasoning',
        item_id: 'rs_1',
        text: '',
      }),
    ],
  })

  expect(screen.queryByRole('status', { name: /thinking/i })).not.toBeInTheDocument()

  rerenderDetail(rerender, {
    session: { ...baseSession, status: 'running' },
    events: [
      event(1, 'agent.status.started', { provider_event_type: 'turn/started' }),
      event(2, 'agent.thinking.completed', {
        provider_event_type: 'item/completed',
        item_type: 'reasoning',
        item_id: 'rs_1',
        text: '',
      }),
      event(3, 'agent.thinking.started', {
        provider_event_type: 'item/started',
        item_type: 'reasoning',
        item_id: 'rs_2',
      }),
    ],
  })

  expect(screen.getByRole('status', { name: /thinking/i })).toBeInTheDocument()
})

test('mobile header shows status as a dot indicator', () => {
  renderDetail({ session: { ...baseSession, status: 'failed' } })

  expect(screen.getByRole('img', { name: 'Session status: failed' })).toBeInTheDocument()
  expect(screen.queryByText('failed')).not.toBeInTheDocument()
})

test('mobile header shows the agent chip without date metadata', () => {
  renderDetail()

  expect(screen.getByLabelText('Agent: fake')).toHaveTextContent('fake')
  expect(screen.queryByText(/Created:/)).not.toBeInTheDocument()
  expect(screen.queryByText(/Updated:/)).not.toBeInTheDocument()
  expect(screen.queryByText(/Last event:/)).not.toBeInTheDocument()
})

test('floating chat header shows session details and copies the session key', async () => {
  const user = userEvent.setup()
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })

  renderDetail()

  expect(screen.queryByText('sess_1')).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Session details' }))

  const popover = screen.getByRole('dialog', { name: 'Session details' })
  expect(within(popover).getByText('Session key')).toBeInTheDocument()
  expect(within(popover).getByText('sess_1')).toBeInTheDocument()
  expect(within(popover).getByText('Workspace path')).toBeInTheDocument()
  expect(within(popover).getByText('/repo')).toBeInTheDocument()

  await user.click(within(popover).getByRole('button', { name: 'Copy session key' }))
  await user.click(within(popover).getByRole('button', { name: 'Copy workspace path' }))

  expect(writeText).toHaveBeenCalledWith('sess_1')
  expect(writeText).toHaveBeenCalledWith('/repo')
  expect(screen.queryByRole('button', { name: 'Theme: System' })).not.toBeInTheDocument()
})

test('floating chat header updates run dangerously for codex sessions', async () => {
  const user = userEvent.setup()
  const onUpdateAgentOptions = vi.fn(async () => undefined)

  renderDetail({
    session: {
      ...baseSession,
      agent_type: 'codex',
      agent_options: { codex: { run_dangerously: false } },
    },
    onUpdateAgentOptions,
  })

  await user.click(screen.getByRole('button', { name: 'Session details' }))
  const checkbox = screen.getByRole('checkbox', { name: /run dangerously/i })

  expect(checkbox).not.toBeChecked()

  await user.click(checkbox)

  expect(onUpdateAgentOptions).toHaveBeenCalledWith({ codex: { run_dangerously: true } })
})

test('floating chat header hides run dangerously for non-codex sessions', async () => {
  const user = userEvent.setup()

  renderDetail()

  await user.click(screen.getByRole('button', { name: 'Session details' }))

  expect(screen.queryByRole('checkbox', { name: /run dangerously/i })).not.toBeInTheDocument()
})

test('floating chat header owns session errors', () => {
  renderDetail({
    streamError: 'HTTP 502',
    errorMessage: 'HTTP 502',
  })

  expect(screen.getByRole('alert')).toHaveTextContent('HTTP 502')
  expect(screen.queryByText(/Failed to load chat history/)).not.toBeInTheDocument()
})

test('message section renders chat with a bottom debug toggle', async () => {
  const user = userEvent.setup()
  const onShowDebugEventsChange = vi.fn()

  renderDetail({ onShowDebugEventsChange })

  expect(screen.getByText('No messages yet. Submit a prompt to start the chat.')).toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: 'Debug' })).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Debug' }))

  expect(onShowDebugEventsChange).toHaveBeenCalledWith(true)
})

type SessionDetailProps = ComponentProps<typeof SessionDetail>

function renderDetail(overrides: Partial<SessionDetailProps> = {}) {
  return render(<SessionDetail {...props(overrides)} />)
}

function rerenderDetail(rerender: (ui: ReactNode) => void, overrides: Partial<SessionDetailProps> = {}) {
  rerender(<SessionDetail {...props(overrides)} />)
}

function props(overrides: Partial<SessionDetailProps>): SessionDetailProps {
  return {
    session: baseSession,
    events: [],
    streamState: 'connected',
    streamError: '',
    notice: '',
    showDebugEvents: false,
    onShowDebugEventsChange: () => undefined,
    onSubmitPrompt: async () => undefined,
    onAnswerUserInput: async () => undefined,
    onCancel: async () => undefined,
    onRefresh: () => undefined,
    onUpdateTitle: async () => undefined,
    onUpdateAgentOptions: async () => undefined,
    ...overrides,
  }
}

function event(seq: number, type: string, payload: Record<string, unknown>): AgentEvent {
  return {
    id: `evt_${seq}`,
    session_id: 'sess_1',
    seq,
    type,
    role: 'assistant',
    status: type.endsWith('.completed') ? 'completed' : 'started',
    payload,
    created_at: '2026-06-12T16:00:00Z',
  }
}
