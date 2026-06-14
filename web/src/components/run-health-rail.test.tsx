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
  archived_at: null,
}

test('run health rail shows metrics and active chat status without session identity', () => {
  const onArchive = vi.fn(async () => undefined)

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
      onArchive={onArchive}
    />,
  )

  expect(screen.queryByText('Session')).not.toBeInTheDocument()
  expect(screen.queryByText('Inspect repo')).not.toBeInTheDocument()
  expect(screen.queryByText('sess_1')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Copy session id' })).not.toBeInTheDocument()
  expect(screen.getByRole('img', { name: 'Active chat: Running' })).toHaveClass(
    'animate-pulse',
    'bg-[hsl(var(--success))]',
  )
  expect(screen.queryByText('Running')).not.toBeInTheDocument()
  expect(screen.queryByText('fake')).not.toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: /chat/i })).not.toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: /debug/i })).not.toBeInTheDocument()
  expect(screen.getByText('Events')).toBeInTheDocument()
  expect(screen.getByText('Tools')).toBeInTheDocument()
  expect(screen.getByText('Agent message')).toBeInTheDocument()
  expect(screen.queryByText('Connection')).not.toBeInTheDocument()
  expect(screen.queryByText('Live')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /refresh/i })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /cancel run/i })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /theme/i })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Archive selected session' })).toBeDisabled()
})

test('run health rail archives an idle session from the slice action', async () => {
  const user = userEvent.setup()
  const onArchive = vi.fn(async () => undefined)

  render(
    <RunHealthRail
      session={{ ...session, status: 'idle' }}
      events={[]}
      streamState="connected"
      streamError=""
      onArchive={onArchive}
    />,
  )

  await user.click(screen.getByRole('button', { name: 'Archive selected session' }))

  expect(onArchive).toHaveBeenCalledOnce()
})

test('run health rail latest event shows provider event type', () => {
  render(
    <RunHealthRail
      session={session}
      events={[
        event(1, 'provider.codex.event', 'system', 'completed', { provider_event_type: 'turn/completed' }),
      ]}
      streamState="connected"
      streamError=""
      onArchive={async () => undefined}
    />,
  )

  expect(screen.getByText('turn/completed')).toBeInTheDocument()
  expect(screen.queryByText('provider.codex.event')).not.toBeInTheDocument()
})

test('run health rail shows latest token usage summary', () => {
  render(
    <RunHealthRail
      session={session}
      events={[
        event(1, 'provider.codex.event', 'system', 'completed', {
          provider: 'codex',
          provider_event_type: 'thread/tokenUsage/updated',
          raw: tokenUsageRaw(),
        }),
      ]}
      streamState="connected"
      streamError=""
      onArchive={async () => undefined}
    />,
  )

  expect(screen.getByText('Tokens')).toBeInTheDocument()
  expect(screen.getByText('5%')).toBeInTheDocument()
  expect(screen.getByText('14k / 258k')).toBeInTheDocument()
  expect(screen.getByText('Input')).toBeInTheDocument()
  expect(screen.getByText('Output')).toBeInTheDocument()
  expect(screen.getByText('4.5k cached (32%)')).toBeInTheDocument()
  expect(screen.getByText('0 reasoning')).toBeInTheDocument()
})

test('run health rail active chat dot shows disconnected state', () => {
  render(
    <RunHealthRail
      session={session}
      events={[]}
      streamState="disconnected"
      streamError="lost connection"
      onArchive={async () => undefined}
    />,
  )

  expect(screen.getByRole('img', { name: 'Active chat: Disconnected' })).toHaveClass('bg-destructive')
  expect(screen.queryByText('lost connection')).not.toBeInTheDocument()
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

function tokenUsageRaw() {
  return {
    threadId: '019ec777-787f-7742-9909-38e1d24b9502',
    turnId: '019ec777-7938-73c0-b031-140f55aa66a1',
    tokenUsage: {
      total: {
        totalTokens: 13903,
        inputTokens: 13884,
        cachedInputTokens: 4480,
        outputTokens: 19,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 13903,
        inputTokens: 13884,
        cachedInputTokens: 4480,
        outputTokens: 19,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 258400,
    },
  }
}
