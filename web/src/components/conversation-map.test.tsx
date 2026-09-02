import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentEvent } from '@/lib/api'
import { ConversationMap } from '@/components/conversation-map'

test('renders grouped visual segments and selects their sequence', async () => {
  const user = userEvent.setup()
  const onSelectSeq = vi.fn()
  render(
    <ConversationMap
      events={conversationEvents()}
      hasOlderEvents={false}
      hasNewerEvents={false}
      loadingOlderEvents={false}
      loadingNewerEvents={false}
      visibleRange={{ firstSeq: 1, lastSeq: 1 }}
      focusedSeq={4}
      onSelectSeq={onSelectSeq}
    />,
  )

  const userSegment = screen.getByRole('button', { name: /Open User message · #1/ })
  const agentSegment = screen.getByRole('button', { name: /Open Agent response · #2–4/ })
  expect(userSegment).toHaveClass('bg-primary/42')
  expect(userSegment).not.toHaveClass('ring-2', 'ring-offset-1')
  expect(agentSegment).toHaveClass(
    'bg-[hsl(var(--foreground)/0.15)]',
    'shadow-[0_0_0_2px_hsl(var(--primary)/0.45)]',
  )

  await user.click(agentSegment)
  expect(onSelectSeq).toHaveBeenCalledWith(2)
})

test('pages through a bounded conversation window and jumps to latest', async () => {
  const user = userEvent.setup()
  const onLoadOlderEvents = vi.fn()
  const onLoadNewerEvents = vi.fn()
  const onJumpToLatest = vi.fn()
  render(
    <ConversationMap
      events={conversationEvents()}
      hasOlderEvents
      hasNewerEvents
      loadingOlderEvents={false}
      loadingNewerEvents={false}
      visibleRange={null}
      focusedSeq={0}
      onLoadOlderEvents={onLoadOlderEvents}
      onLoadNewerEvents={onLoadNewerEvents}
      onJumpToLatest={onJumpToLatest}
    />,
  )

  await user.click(screen.getByRole('button', { name: 'Load earlier conversation turns' }))
  await user.click(screen.getByRole('button', { name: 'Load newer conversation turns' }))
  await user.click(screen.getByRole('button', { name: 'Jump conversation map to latest' }))

  expect(onLoadOlderEvents).toHaveBeenCalledOnce()
  expect(onLoadNewerEvents).toHaveBeenCalledOnce()
  expect(onJumpToLatest).toHaveBeenCalledOnce()
})

test('shows an empty state without user-facing conversation events', () => {
  render(
    <ConversationMap
      events={[]}
      hasOlderEvents={false}
      hasNewerEvents={false}
      loadingOlderEvents={false}
      loadingNewerEvents={false}
      visibleRange={null}
      focusedSeq={0}
    />,
  )

  expect(screen.getByText('No conversation yet.')).toBeInTheDocument()
})

function conversationEvents(): AgentEvent[] {
  return [
    event(1, 'user.message.completed', 'user', { text: 'Inspect the failing build' }),
    event(2, 'tool.call.started', 'assistant', { item_id: 'tool_1', command: 'bun test' }, 'started'),
    event(3, 'tool.call.completed', 'assistant', { item_id: 'tool_1', output: 'ok' }),
    event(4, 'agent.message.completed', 'assistant', { text: 'The build is healthy.' }),
  ]
}

function event(
  seq: number,
  type: string,
  role: string,
  payload: Record<string, unknown>,
  status = 'completed',
): AgentEvent {
  return {
    id: `evt_${seq}`,
    session_id: 'sess_1',
    seq,
    type,
    role,
    status,
    payload,
    created_at: `2026-06-12T16:0${seq}:00Z`,
  }
}
