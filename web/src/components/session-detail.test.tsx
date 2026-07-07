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

test('mobile session details menu exposes right-rail session actions', async () => {
  const user = userEvent.setup()
  const onClear = vi.fn(async () => undefined)
  const onCompact = vi.fn(async () => undefined)
  const onToggleArchive = vi.fn(async () => undefined)
  const onOpenWorkspaceDetails = vi.fn()

  renderDetail({
    session: { ...baseSession, agent_type: 'codex', provider_session_id: 'thread_1' },
    onClear,
    onCompact,
    onToggleArchive,
    onOpenWorkspaceDetails,
  })

  const mobileHeader = screen.getByTestId('mobile-floating-session-header')

  await user.click(within(mobileHeader).getByRole('button', { name: 'Session details' }))
  await user.click(within(mobileHeader).getByRole('button', { name: 'Workspace details' }))

  await user.click(within(mobileHeader).getByRole('button', { name: 'Session details' }))
  await user.click(within(mobileHeader).getByRole('button', { name: 'Clear context' }))

  await user.click(within(mobileHeader).getByRole('button', { name: 'Session details' }))
  await user.click(within(mobileHeader).getByRole('button', { name: 'Compact context' }))

  await user.click(within(mobileHeader).getByRole('button', { name: 'Session details' }))
  await user.click(within(mobileHeader).getByRole('button', { name: 'Archive session' }))

  expect(onOpenWorkspaceDetails).toHaveBeenCalledOnce()
  expect(onClear).toHaveBeenCalledOnce()
  expect(onCompact).toHaveBeenCalledOnce()
  expect(onToggleArchive).toHaveBeenCalledOnce()
})

test('desktop session details menu does not duplicate right-rail actions', async () => {
  const user = userEvent.setup()

  renderDetail({
    session: { ...baseSession, agent_type: 'codex', provider_session_id: 'thread_1' },
    onClear: async () => undefined,
    onCompact: async () => undefined,
    onToggleArchive: async () => undefined,
  })

  const desktopHeader = desktopFloatingHeader()
  await user.click(within(desktopHeader).getByRole('button', { name: 'Session details' }))
  const dialog = within(desktopHeader).getByRole('dialog', { name: 'Session details' })

  expect(within(dialog).queryByRole('button', { name: 'Clear context' })).not.toBeInTheDocument()
  expect(within(dialog).queryByRole('button', { name: 'Compact context' })).not.toBeInTheDocument()
  expect(within(dialog).queryByRole('button', { name: 'Archive session' })).not.toBeInTheDocument()
  expect(within(dialog).queryByRole('button', { name: 'Workspace details' })).not.toBeInTheDocument()
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

  await user.click(within(desktopFloatingHeader()).getByRole('button', { name: 'Session details' }))

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

  await user.click(within(desktopFloatingHeader()).getByRole('button', { name: 'Session details' }))
  const switchControl = within(desktopFloatingHeader()).getByRole('switch', { name: /run dangerously/i })

  expect(switchControl).toHaveAttribute('aria-checked', 'false')

  await user.click(switchControl)

  expect(onUpdateAgentOptions).toHaveBeenCalledWith({ codex: { run_dangerously: true } })
})

test('floating chat header updates run dangerously for claude sessions', async () => {
  const user = userEvent.setup()
  const onUpdateAgentOptions = vi.fn(async () => undefined)

  renderDetail({
    session: {
      ...baseSession,
      agent_type: 'claude',
      agent_options: { claude: { run_dangerously: false } },
    },
    onUpdateAgentOptions,
  })

  await user.click(within(desktopFloatingHeader()).getByRole('button', { name: 'Session details' }))
  const switchControl = within(desktopFloatingHeader()).getByRole('switch', { name: /run dangerously/i })

  expect(switchControl).toHaveAttribute('aria-checked', 'false')

  await user.click(switchControl)

  expect(onUpdateAgentOptions).toHaveBeenCalledWith({ claude: { run_dangerously: true } })
})

test('floating chat header hides run dangerously for fake sessions', async () => {
  const user = userEvent.setup()

  renderDetail()

  await user.click(within(desktopFloatingHeader()).getByRole('button', { name: 'Session details' }))

  expect(screen.queryByRole('switch', { name: /run dangerously/i })).not.toBeInTheDocument()
})

test('floating chat header owns session errors', () => {
  renderDetail({
    errorMessage: 'HTTP 502',
  })

  const alert = within(desktopFloatingHeader()).getByRole('alert')
  expect(alert).toHaveTextContent('HTTP 502')
  expect(alert).toHaveClass('command-error-banner', 'text-destructive')
  expect(screen.queryByText(/Failed to load chat history/)).not.toBeInTheDocument()
})

test('session details menu toggles debug events', async () => {
  const user = userEvent.setup()
  const onShowDebugEventsChange = vi.fn()

  renderDetail({ showDebugEvents: true, onShowDebugEventsChange })

  expect(screen.getByText('No messages yet. Submit a prompt to start the chat.')).toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: 'Debug' })).not.toBeInTheDocument()

  await user.click(within(desktopFloatingHeader()).getByRole('button', { name: 'Session details' }))
  const debug = within(desktopFloatingHeader()).getByRole('switch', { name: 'Debug' })

  expect(debug).toHaveAttribute('aria-checked', 'true')

  await user.click(debug)

  expect(onShowDebugEventsChange).toHaveBeenCalledWith(false)
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
    onShowDebugEventsChange: () => undefined,
    onSubmitPrompt: async () => undefined,
    onAnswerUserInput: async () => undefined,
    onCancel: async () => undefined,
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
