import { render, screen, within } from '@testing-library/react'
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

test('session detail shows loading while a routed session resolves', () => {
  renderDetail({ session: null, resolvingSessionID: 'sess_1' })

  expect(screen.getByText('Loading session...')).toBeInTheDocument()
  expect(screen.queryByText('No session selected')).not.toBeInTheDocument()
})

test('session detail keeps session loading visible while initial chat history loads', () => {
  renderDetail({
    resolvingSessionID: 'sess_1',
    streamState: 'loading',
    events: [],
  })

  expect(screen.getByText('Loading session...')).toBeInTheDocument()
  expect(screen.queryByText('Loading chat history...')).not.toBeInTheDocument()
})

test('thinking indicator follows active reasoning events while running', () => {
  const { rerender } = renderDetail()

  expect(screen.queryByRole('status', { name: /thinking/i })).not.toBeInTheDocument()

  rerenderDetail(rerender, {
    session: { ...baseSession, status: 'running' },
    events: [event(1, 'agent.status.started', { provider_event_type: 'turn/started' })],
  })

  const thinkingStatus = screen.getByRole('status', { name: /thinking/i })
  expect(thinkingStatus).toBeInTheDocument()
  expect(screen.getByRole('log', { name: 'Chat messages' })).toContainElement(thinkingStatus)

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

test('running session shows working status after visible activity goes quiet', () => {
  renderDetail({
    session: { ...baseSession, status: 'running' },
    events: [event(1, 'agent.run.started', {})],
  })

  expect(screen.getByRole('status', { name: /working/i })).toBeInTheDocument()
})

test('running session suppresses working status while assistant text streams', () => {
  renderDetail({
    session: { ...baseSession, status: 'running' },
    events: [
      event(1, 'agent.run.started', {}),
      event(2, 'agent.message.delta', { item_id: 'msg_1', text: 'Streaming answer' }),
    ],
  })

  expect(screen.queryByRole('status', { name: /working/i })).not.toBeInTheDocument()
  expect(screen.getByText('Streaming answer')).toBeInTheDocument()
})

test('running session shows working status after streamed assistant text completes', () => {
  renderDetail({
    session: { ...baseSession, status: 'running' },
    events: [
      event(1, 'agent.run.started', {}),
      event(2, 'agent.message.delta', { item_id: 'msg_1', text: 'Streaming answer' }),
      event(3, 'agent.message.completed', { item_id: 'msg_1', text: 'Streaming answer' }),
    ],
  })

  expect(screen.getByRole('status', { name: /working/i })).toBeInTheDocument()
  expect(screen.getByText('Streaming answer')).toBeInTheDocument()
})

test('running session suppresses working status while a tool is active', () => {
  renderDetail({
    session: { ...baseSession, status: 'running' },
    events: [
      event(1, 'agent.run.started', {}),
      event(2, 'agent.message.completed', { item_id: 'msg_1', text: 'Running checks.' }),
      event(3, 'tool.call.started', { item_id: 'tool_1', command: 'sleep 20' }),
    ],
  })

  expect(screen.queryByRole('status', { name: /working/i })).not.toBeInTheDocument()
  expect(screen.getByText('sleep 20')).toBeInTheDocument()
})

test('running session prefers thinking status over quiet working status', () => {
  renderDetail({
    session: { ...baseSession, status: 'running' },
    events: [
      event(1, 'agent.run.started', {}),
      event(2, 'agent.thinking.started', {
        provider_event_type: 'item/started',
        item_type: 'reasoning',
        item_id: 'rs_1',
      }),
    ],
  })

  expect(screen.getByRole('status', { name: /thinking/i })).toBeInTheDocument()
  expect(screen.queryByRole('status', { name: /working/i })).not.toBeInTheDocument()
})

test('pending user input suppresses quiet working status', () => {
  renderDetail({
    session: { ...baseSession, status: 'running' },
    events: [
      event(1, 'agent.run.started', {}),
      event(2, 'agent.input.requested', {
        request_id: 'call_test',
        provider: 'codex',
        provider_event_type: 'item/tool/requestUserInput',
        item_id: 'call_test',
        questions: [
          {
            id: 'approval',
            header: 'Trust',
            question: 'Approve this action?',
            options: [{ label: 'Approve', description: 'Allow the action.' }],
          },
        ],
      }),
    ],
  })

  expect(screen.queryByRole('status', { name: /working/i })).not.toBeInTheDocument()
  expect(screen.getByText('Approve this action?')).toBeInTheDocument()
})

test('session detail uses matching floating headers on mobile and desktop', () => {
  renderDetail({ mobileLeadingAction: <button type="button">Open sessions</button> })

  const mobileHeader = screen.getByTestId('mobile-floating-session-header')
  expect(mobileHeader).toHaveClass('mobile-floating-header-shell')
  expect(mobileHeader).toHaveClass('lg:hidden')
  expect(within(mobileHeader).getByRole('button', { name: 'Open sessions' })).toBeInTheDocument()
  expect(screen.getByTestId('floating-session-header')).toHaveClass('hidden')
  expect(screen.getByTestId('floating-session-header')).toHaveClass('lg:block')
  expect(screen.queryByText(/Created:/)).not.toBeInTheDocument()
  expect(screen.queryByText(/Updated:/)).not.toBeInTheDocument()
  expect(screen.queryByText(/Last event:/)).not.toBeInTheDocument()
})

test('session header gives the title priority without inline settings controls', () => {
  renderDetail()

  const header = desktopFloatingHeader()
  const title = within(header).getByRole('heading', { name: 'Inspect repo' })

  expect(title.parentElement).toHaveClass('min-w-0', 'flex-1')
  expect(within(header).queryByRole('button', { name: 'Session settings' })).not.toBeInTheDocument()
  expect(within(header).queryByRole('button', { name: 'Edit session title' })).not.toBeInTheDocument()
})

test('composer stack floats over the transcript while reserving tail inset', () => {
  renderDetail()

  const bottomStack = screen.getByTestId('session-bottom-stack')
  expect(bottomStack).toHaveClass('pointer-events-auto')
  expect(bottomStack.parentElement).toHaveClass('absolute')
  expect(bottomStack.parentElement).toHaveClass('bottom-0')
  expect(bottomStack.parentElement).toHaveClass('session-bottom-safe-area')
  expect(bottomStack).toContainElement(screen.getByLabelText('Prompt'))
  expect(screen.getByText('No messages yet. Submit a prompt to start the chat.')).toBeInTheDocument()
})

test('chat presents session errors as a centered transcript status', () => {
  renderDetail({
    errorMessage: 'HTTP 502',
  })

  const transcript = screen.getByRole('log', { name: 'Chat messages' })
  const alert = within(transcript).getByRole('alert')
  const header = within(desktopFloatingHeader()).getByText('Inspect repo').closest('.command-chat-header')
  expect(within(desktopFloatingHeader()).queryByRole('alert')).not.toBeInTheDocument()
  expect(alert).toHaveTextContent('Chat issue')
  expect(alert).toHaveTextContent('HTTP 502')
  expect(alert).toHaveClass('mx-auto', 'justify-center', 'text-center')
  expect(header).toHaveClass('rounded-xl')
  expect(screen.queryByText(/Failed to load chat history/)).not.toBeInTheDocument()
})

type SessionDetailProps = ComponentProps<typeof SessionDetail>

function renderDetail(overrides: Partial<SessionDetailProps> = {}) {
  return render(<SessionDetail {...props(overrides)} />)
}

function rerenderDetail(rerender: (ui: ReactNode) => void, overrides: Partial<SessionDetailProps> = {}) {
  rerender(<SessionDetail {...props(overrides)} />)
}

function desktopFloatingHeader() {
  return screen.getByTestId('floating-session-header')
}

function props(overrides: Partial<SessionDetailProps>): SessionDetailProps {
  return {
    session: baseSession,
    events: [],
    streamState: 'connected',
    showDebugEvents: false,
    onSubmitPrompt: async () => undefined,
    onAnswerUserInput: async () => undefined,
    onCancel: async () => undefined,
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
