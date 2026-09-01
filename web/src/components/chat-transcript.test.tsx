import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode, type ComponentProps } from 'react'
import type { AgentEvent } from '@/lib/api'
import { ChatTranscript as ChatTranscriptComponent } from '@/components/chat-transcript'

function ChatTranscript(props: ComponentProps<typeof ChatTranscriptComponent>) {
  return <ChatTranscriptComponent autoScroll {...props} />
}

test('renders user and assistant messages without duplicating completion text', () => {
  const { container } = render(
    <ChatTranscript
      events={[
        event(1, 'user.message.completed', 'user', 'completed', { text: 'Hello' }),
        event(2, 'agent.message.delta', 'assistant', 'delta', { text: 'Hi' }),
        event(3, 'agent.message.delta', 'assistant', 'delta', { text: ' there' }),
        event(4, 'agent.message.completed', 'assistant', 'completed', { text: 'Hi there' }),
      ]}
    />,
  )

  expect(screen.getByText('Hello')).toBeInTheDocument()
  expect(screen.getByText('Hi there')).toBeInTheDocument()
  expect(screen.queryByText('Hi thereHi there')).not.toBeInTheDocument()
  expect(container.querySelectorAll('time[datetime="2026-06-12T16:00:00Z"]')).toHaveLength(2)
  const firstTimestamp = container.querySelector('time[datetime="2026-06-12T16:00:00Z"]')
  expect(firstTimestamp).toBeVisible()
  const timestampPosition = firstTimestamp?.compareDocumentPosition(screen.getByText('Hello')) ?? 0
  expect(timestampPosition & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  )
  expect(screen.getAllByRole('button', { name: 'Copy message' })).toHaveLength(2)
})

test('renders connection errors after the message list as a centered status', () => {
  render(
    <ChatTranscript
      error="HTTP 502"
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'Last response' })]}
    />,
  )

  const message = screen.getByText('Last response')
  const alert = screen.getByRole('alert')
  const position = message.compareDocumentPosition(alert)

  expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  expect(alert).toHaveTextContent('Chat issue')
  expect(alert).toHaveTextContent('HTTP 502')
  expect(alert).toHaveClass('mx-auto', 'justify-center', 'text-center')
})

test('adds the date only to the first message after a local day boundary', () => {
  const firstTimestamp = '2026-06-12T23:50:00'
  const sameDayTimestamp = '2026-06-12T23:55:00'
  const nextDayTimestamp = '2026-06-13T00:05:00'
  const { container } = render(
    <ChatTranscript
      events={[
        { ...event(1, 'user.message.completed', 'user', 'completed', { text: 'Late prompt' }), created_at: firstTimestamp },
        { ...event(2, 'agent.message.completed', 'assistant', 'completed', { text: 'Late answer' }), created_at: sameDayTimestamp },
        { ...event(3, 'user.message.completed', 'user', 'completed', { text: 'Next prompt' }), created_at: nextDayTimestamp },
      ]}
    />,
  )

  const firstTime = container.querySelector(`time[datetime="${firstTimestamp}"]`)
  const sameDayTime = container.querySelector(`time[datetime="${sameDayTimestamp}"]`)
  const nextDayTime = container.querySelector(`time[datetime="${nextDayTimestamp}"]`)

  expect(firstTime).toHaveTextContent(new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(firstTimestamp)))
  expect(sameDayTime).toHaveTextContent(new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(sameDayTimestamp)))
  expect(nextDayTime).toHaveTextContent(
    new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(nextDayTimestamp)),
  )
})

test('shows the completed response time and total turn duration', () => {
  const completedAt = '2026-06-12T16:04:00Z'
  const { container } = render(
    <ChatTranscript
      events={[
        { ...event(1, 'user.message.completed', 'user', 'completed', { text: 'Do the work' }), created_at: '2026-06-12T16:03:25Z' },
        { ...event(2, 'agent.run.started', 'assistant', 'started', {}), created_at: '2026-06-12T16:03:26Z' },
        { ...event(3, 'agent.message.completed', 'assistant', 'completed', { item_id: 'msg_1', text: 'Done' }), created_at: completedAt },
      ]}
    />,
  )

  expect(container.querySelector(`time[datetime="${completedAt}"]`)).toHaveTextContent(
    new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(completedAt)),
  )
  expect(screen.getByLabelText('Total turn time 34 sec')).toHaveTextContent('34 sec')
})

test('renders session actions as conversation breaks', () => {
  render(
    <ChatTranscript
      events={[
        event(1, 'user.message.completed', 'user', 'completed', { text: 'Hello' }),
        event(2, 'session.action.completed', 'system', 'completed', {
          action: 'clear',
          text: 'Clear context',
        }),
        event(3, 'agent.message.completed', 'assistant', 'completed', { text: 'Done' }),
      ]}
    />,
  )

  expect(screen.getByRole('separator', { name: 'CONVERSATION CLEARED' })).toBeInTheDocument()
  expect(screen.getByText('CONVERSATION CLEARED')).toBeInTheDocument()
  expect(screen.queryByText('Clear context')).not.toBeInTheDocument()
})

test('renders workspace changes with their old and new paths', () => {
  render(
    <ChatTranscript
      events={[
        event(1, 'session.action.completed', 'system', 'completed', {
          action: 'workspace_changed',
          label: 'WORKSPACE CHANGED',
          previous_workspace_path: '/repo/old',
          workspace_path: '/repo/new',
        }),
      ]}
    />,
  )

  expect(screen.getByRole('separator', { name: 'WORKSPACE CHANGED' })).toBeInTheDocument()
  expect(screen.getByText('/repo/old -> /repo/new')).toBeInTheDocument()
})

test('renders run failures as system error rows instead of assistant text', () => {
  const errorText = 'read codex app-server stdout: bufio.Scanner: token too long'

  render(
    <ChatTranscript
      events={[
        event(1, 'user.message.completed', 'user', 'completed', { text: 'Keep working' }),
        event(2, 'agent.message.completed', 'assistant', 'completed', { text: 'I started the change.' }),
        event(3, 'agent.run.failed', 'assistant', 'failed', { error: errorText }),
      ]}
    />,
  )

  const alert = screen.getByRole('alert', { name: `Run failed: ${errorText}` })
  expect(alert).toHaveTextContent('Run failed')
  expect(alert).toHaveTextContent(errorText)
  expect(alert).toHaveTextContent('#3')
  expect(alert.querySelector('time')).toHaveClass('hidden')
  expect(alert.querySelector('time')).toHaveClass('sm:inline')

  const assistantMessage = screen.getByText('I started the change.').closest('article')
  expect(assistantMessage).toHaveTextContent('I started the change.')
  expect(assistantMessage).not.toHaveTextContent(errorText)
})

test('renders markdown in chat messages', () => {
  render(
    <ChatTranscript
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', {
          item_id: 'msg_1',
          text: '**Section 1**\n\n- First item\n- Second item',
        }),
      ]}
    />,
  )

  expect(screen.getByText('Section 1').tagName).toBe('STRONG')
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  expect(screen.getByText('First item')).toBeInTheDocument()
})

test('opens markdown file links in the file editor action', async () => {
  const user = userEvent.setup()
  const onOpenFilePath = vi.fn()

  render(
    <ChatTranscript
      onOpenFilePath={onOpenFilePath}
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', {
          text: 'Changed [chat-transcript.tsx](/Users/joey/Source/gorchestra/web/src/components/chat-transcript.tsx:54).',
        }),
      ]}
    />,
  )

  await user.click(screen.getByRole('link', { name: 'chat-transcript.tsx' }))

  expect(onOpenFilePath).toHaveBeenCalledWith('/Users/joey/Source/gorchestra/web/src/components/chat-transcript.tsx')
})

test('renders legacy raw Codex plan messages with a plan label', () => {
  const planText = 'Review `README.md` before running:\n\n```sh\nbun test\n```\n'
  const { container } = render(
    <ChatTranscript
      events={[
        event(1, 'provider.codex.event', 'system', 'completed', {
          provider_event_type: 'item/plan/delta',
          raw: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'plan_1', delta: planText },
        }),
        event(2, 'provider.codex.event', 'system', 'completed', {
          provider_event_type: 'item/completed',
          raw: {
            threadId: 'thread_1',
            turnId: 'turn_1',
            item: { type: 'plan', id: 'plan_1', text: planText },
          },
        }),
      ]}
    />,
  )

  expect(screen.getByText('Plan')).toBeInTheDocument()
  expect(screen.getByText('README.md')).toHaveClass('bg-amber-100/85')
  expect(screen.getByText(/bun test/)).toHaveClass('bg-amber-100/80')
  expect(screen.queryByText('item/plan/delta')).not.toBeInTheDocument()
  expect(screen.getByText('Plan').closest('article')).toHaveAttribute('data-message-variant', 'plan')
  expect(container.querySelector('.border-l-amber-400')).toBeInTheDocument()
})

test('does not render pagination controls in either direction', () => {
  render(
    <ChatTranscript
      hasOlderEvents
      hasNewerEvents
      onLoadOlderEvents={() => undefined}
      onLoadNewerEvents={() => undefined}
      events={[event(251, 'agent.message.completed', 'assistant', 'completed', { text: 'Tail' })]}
    />,
  )

  expect(screen.queryByRole('button', { name: 'Load older events' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Load newer events' })).not.toBeInTheDocument()
})

test('uses fixed transcript bottom breathing room', () => {
  render(
    <ChatTranscript
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'Tail' })]}
    />,
  )

  expect(screen.getByTestId('chat-transcript-tail-spacer')).toHaveStyle({ height: '10px' })
})

test('adds breathing room after the measured bottom inset', () => {
  render(
    <ChatTranscript
      bottomInsetHeight={260}
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'Tail' })]}
    />,
  )

  expect(screen.getByTestId('chat-transcript-tail-spacer')).toHaveStyle({ height: '270px' })
})

test('positions and clears the hatch glow from mouse movement', () => {
  const { container } = render(
    <ChatTranscript
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'Tail' })]}
    />,
  )
  const canvas = container.querySelector<HTMLDivElement>('.chat-canvas')
  expect(canvas).not.toBeNull()
  if (!canvas) return

  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    x: 100,
    y: 50,
    left: 100,
    top: 50,
    right: 500,
    bottom: 450,
    width: 400,
    height: 400,
    toJSON: () => ({}),
  })

  fireEvent.pointerMove(canvas, { clientX: 136, clientY: 92, pointerType: 'mouse' })

  expect(canvas).toHaveStyle({ '--chat-glow-x': '36px', '--chat-glow-y': '42px' })
  expect(canvas).toHaveAttribute('data-glow-active', 'true')

  fireEvent.pointerLeave(canvas, { pointerType: 'mouse' })

  expect(canvas).not.toHaveAttribute('data-glow-active')
})

test('does not activate the hatch glow for touch input', () => {
  const { container } = render(
    <ChatTranscript
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'Tail' })]}
    />,
  )
  const canvas = container.querySelector<HTMLDivElement>('.chat-canvas')
  expect(canvas).not.toBeNull()
  if (!canvas) return

  fireEvent.pointerMove(canvas, { clientX: 20, clientY: 20, pointerType: 'touch' })

  expect(canvas).not.toHaveAttribute('data-glow-active')
})

test('renders thinking activity status where the transcript tail indicator appears', () => {
  render(<ChatTranscript activityStatus={{ kind: 'thinking' }} events={[]} />)

  expect(screen.getByRole('status', { name: 'Thinking' })).toBeInTheDocument()
  expect(screen.getByRole('log', { name: 'Chat messages' })).toContainElement(
    screen.getByRole('status', { name: 'Thinking' }),
  )
})

test('renders working activity status with a quiet-time counter', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-06-12T16:00:05Z'))

  try {
    render(<ChatTranscript activityStatus={{ kind: 'working', since: '2026-06-12T16:00:00Z' }} events={[]} />)

    expect(screen.getByRole('status', { name: 'Working for 5 seconds' })).toBeInTheDocument()

    act(() => {
      vi.setSystemTime(new Date('2026-06-12T16:00:07Z'))
      vi.advanceTimersByTime(1000)
    })

    expect(screen.getByRole('status', { name: 'Working for 8 seconds' })).toBeInTheDocument()
  } finally {
    vi.useRealTimers()
  }
})

test('scrolling near the top automatically loads older history once', async () => {
  let resolveLoad: () => void = () => undefined
  const onLoadOlderEvents = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveLoad = resolve
      }),
  )

  render(
    <ChatTranscript
      hasOlderEvents
      onLoadOlderEvents={onLoadOlderEvents}
      events={[event(251, 'agent.message.completed', 'assistant', 'completed', { text: 'Tail' })]}
    />,
  )

  const log = screen.getByRole('log', { name: 'Chat messages' })
  setScrollMetrics(log, { scrollTop: 120, scrollHeight: 1000, clientHeight: 400 })
  fireEvent.wheel(log, { deltaY: -100 })
  fireEvent.scroll(log, { target: { scrollTop: 120 } })
  fireEvent.scroll(log, { target: { scrollTop: 120 } })

  expect(onLoadOlderEvents).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: 'Load older events' })).not.toBeInTheDocument()

  resolveLoad()
})

test('does not load older events from an incidental programmatic leading edge', () => {
  const onLoadOlderEvents = vi.fn()

  render(
    <ChatTranscript
      hasOlderEvents
      onLoadOlderEvents={onLoadOlderEvents}
      events={[event(251, 'agent.message.completed', 'assistant', 'completed', { text: 'Tail' })]}
    />,
  )

  const log = screen.getByRole('log', { name: 'Chat messages' })
  fireEvent.scroll(log, { target: { scrollTop: 0 } })

  expect(onLoadOlderEvents).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Load older events' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()
})

test('adjusts the virtual list origin when older timeline rows are prepended', async () => {
  let resolveLoad: () => void = () => undefined
  const { rerender } = render(
    <ChatTranscript
      hasOlderEvents
      onLoadOlderEvents={() =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve
        })}
      events={[
        event(251, 'user.message.completed', 'user', 'completed', { text: 'Tail prompt 1' }),
        event(252, 'agent.message.completed', 'assistant', 'completed', { text: 'Tail 1' }),
        event(253, 'user.message.completed', 'user', 'completed', { text: 'Tail prompt 2' }),
        event(254, 'agent.message.completed', 'assistant', 'completed', { text: 'Tail 2' }),
      ]}
    />,
  )

  const log = screen.getByRole('log', { name: 'Chat messages' })
  expect(log).toHaveAttribute('data-first-item-index', '1000000')

  fireEvent.wheel(log, { deltaY: -100 })
  fireEvent.scroll(log, { target: { scrollTop: 0 } })

  resolveLoad()
  rerender(
    <ChatTranscript
      hasOlderEvents
      loadingOlderEvents={false}
      onLoadOlderEvents={() => Promise.resolve()}
      events={[
        event(240, 'user.message.completed', 'user', 'completed', { text: 'Older prompt' }),
        event(241, 'agent.message.completed', 'assistant', 'completed', { text: 'Older answer' }),
        event(251, 'user.message.completed', 'user', 'completed', { text: 'Tail prompt 1' }),
        event(252, 'agent.message.completed', 'assistant', 'completed', { text: 'Tail 1' }),
        event(253, 'user.message.completed', 'user', 'completed', { text: 'Tail prompt 2' }),
        event(254, 'agent.message.completed', 'assistant', 'completed', { text: 'Tail 2' }),
      ]}
    />,
  )

  expect(log).toHaveAttribute('data-first-item-index', '999998')
})

test('does not issue another older request while older events are loading', () => {
  const onLoadOlderEvents = vi.fn()
  render(
    <ChatTranscript
      hasOlderEvents
      loadingOlderEvents
      onLoadOlderEvents={onLoadOlderEvents}
      events={[event(251, 'agent.message.completed', 'assistant', 'completed', { text: 'Tail' })]}
    />,
  )

  const log = screen.getByRole('log', { name: 'Chat messages' })
  fireEvent.scroll(log, { target: { scrollTop: 0 } })

  expect(onLoadOlderEvents).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Load older events' })).not.toBeInTheDocument()
})

test('scrolling toward newer history loads the next page before entering the tail snap zone', () => {
  const onLoadNewerEvents = vi.fn()
  const onJumpToLatest = vi.fn()
  render(
    <ChatTranscript
      pinToLatestOnMount
      hasNewerEvents
      onLoadNewerEvents={onLoadNewerEvents}
      onJumpToLatest={onJumpToLatest}
      events={[event(251, 'agent.message.completed', 'assistant', 'completed', { text: 'Tail' })]}
    />,
  )

  const log = screen.getByRole('log', { name: 'Chat messages' })
  setScrollMetrics(log, { scrollTop: 600, scrollHeight: 2000, clientHeight: 400 })
  fireEvent.wheel(log, { deltaY: 100 })
  fireEvent.scroll(log)

  expect(onLoadNewerEvents).toHaveBeenCalledOnce()
  expect(onJumpToLatest).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Load newer events' })).not.toBeInTheDocument()
})

test('mobile scrolling into the tail snap zone waits for momentum to settle before adopting newer events', async () => {
  const onLoadNewerEvents = vi.fn()
  const onJumpToLatest = vi.fn()
  const { rerender } = render(
    <ChatTranscript
      pinToLatestOnMount
      hasNewerEvents
      onLoadNewerEvents={onLoadNewerEvents}
      onJumpToLatest={onJumpToLatest}
      events={[event(251, 'agent.message.completed', 'assistant', 'completed', { text: 'Tail' })]}
    />,
  )

  const log = screen.getByRole('log', { name: 'Chat messages' })
  setScrollMetrics(log, { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })
  fireEvent.touchStart(log, { touches: [{ clientY: 300 }] })
  fireEvent.touchMove(log, { touches: [{ clientY: 200 }] })
  fireEvent.scroll(log)

  expect(onJumpToLatest).not.toHaveBeenCalled()
  expect(onLoadNewerEvents).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()
  fireEvent.touchEnd(log)
  await waitFor(() => expect(onJumpToLatest).toHaveBeenCalledOnce())
  rerender(
    <ChatTranscript
      onLoadNewerEvents={onLoadNewerEvents}
      onJumpToLatest={onJumpToLatest}
      events={[event(252, 'agent.message.completed', 'assistant', 'completed', { text: 'Latest' })]}
    />,
  )
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()
})

test('mobile reverses back into the tail snap zone without ending the touch gesture', async () => {
  const onJumpToLatest = vi.fn()
  render(
    <ChatTranscript
      hasNewerEvents
      onJumpToLatest={onJumpToLatest}
      events={[event(251, 'agent.message.completed', 'assistant', 'completed', { text: 'Tail' })]}
    />,
  )

  const log = screen.getByRole('log', { name: 'Chat messages' })
  setScrollMetrics(log, { scrollTop: 400, scrollHeight: 1200, clientHeight: 400 })
  fireEvent.touchStart(log, { touches: [{ clientY: 200 }] })
  fireEvent.touchMove(log, { touches: [{ clientY: 300 }] })

  setScrollMetrics(log, { scrollTop: 800, scrollHeight: 1200, clientHeight: 400 })
  fireEvent.touchMove(log, { touches: [{ clientY: 200 }] })
  await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())))

  expect(onJumpToLatest).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()
  fireEvent.touchEnd(log)
  await waitFor(() => expect(onJumpToLatest).toHaveBeenCalledOnce())
})

test('mobile snaps before requiring the composer-clearance footer to be scrolled through', async () => {
  const onJumpToLatest = vi.fn()
  render(
    <ChatTranscript
      pinToLatestOnMount
      hasNewerEvents
      bottomInsetHeight={280}
      onJumpToLatest={onJumpToLatest}
      events={[event(251, 'agent.message.completed', 'assistant', 'completed', { text: 'Tail' })]}
    />,
  )

  const log = screen.getByRole('log', { name: 'Chat messages' })
  setScrollMetrics(log, { scrollTop: 700, scrollHeight: 1400, clientHeight: 400 })
  fireEvent.touchStart(log, { touches: [{ clientY: 300 }] })
  fireEvent.touchMove(log, { touches: [{ clientY: 260 }] })
  fireEvent.scroll(log)

  expect(onJumpToLatest).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()
  fireEvent.touchEnd(log)
  await waitFor(() => expect(onJumpToLatest).toHaveBeenCalledOnce())
})

test('mobile rechecks the settled scroll position after the final touch movement', async () => {
  const onJumpToLatest = vi.fn()
  const { rerender } = render(
    <ChatTranscript
      pinToLatestOnMount
      hasNewerEvents
      bottomInsetHeight={280}
      onJumpToLatest={onJumpToLatest}
      events={[event(251, 'agent.message.completed', 'assistant', 'completed', { text: 'Tail' })]}
    />,
  )

  const log = screen.getByRole('log', { name: 'Chat messages' })
  setScrollMetrics(log, { scrollTop: 200, scrollHeight: 1400, clientHeight: 400 })
  fireEvent.touchStart(log, { touches: [{ clientY: 300 }] })
  fireEvent.touchMove(log, { touches: [{ clientY: 260 }] })
  expect(screen.getByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).toBeInTheDocument()

  setScrollMetrics(log, { scrollTop: 700, scrollHeight: 1400, clientHeight: 400 })
  fireEvent.touchEnd(log)
  await waitFor(() => expect(onJumpToLatest).toHaveBeenCalledOnce())
  rerender(
    <ChatTranscript
      pinToLatestOnMount
      bottomInsetHeight={280}
      onJumpToLatest={onJumpToLatest}
      events={[event(252, 'agent.message.completed', 'assistant', 'completed', { text: 'Latest' })]}
    />,
  )
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()
})

test('resumes following after endless newer loading reaches the true tail', async () => {
  const onLoadNewerEvents = vi.fn()
  const onFollowingTailChange = vi.fn()
  const { rerender } = render(
    <ChatTranscript
      autoScroll={false}
      hasNewerEvents
      onLoadNewerEvents={onLoadNewerEvents}
      onFollowingTailChange={onFollowingTailChange}
      events={[event(251, 'agent.message.completed', 'assistant', 'completed', { text: 'Older' })]}
    />,
  )
  const log = screen.getByRole('log', { name: 'Chat messages' })
  setScrollMetrics(log, { scrollTop: 600, scrollHeight: 2000, clientHeight: 400 })
  fireEvent.wheel(log, { deltaY: 100 })
  fireEvent.scroll(log)
  expect(onLoadNewerEvents).toHaveBeenCalledOnce()

  setScrollMetrics(log, { scrollTop: 600, scrollHeight: 1200, clientHeight: 400 })
  rerender(
    <ChatTranscript
      autoScroll={false}
      onLoadNewerEvents={onLoadNewerEvents}
      onFollowingTailChange={onFollowingTailChange}
      events={[
        event(251, 'agent.message.completed', 'assistant', 'completed', { text: 'Older' }),
        event(252, 'agent.message.completed', 'assistant', 'completed', { text: 'Latest' }),
      ]}
    />,
  )

  await waitFor(() => expect(log.scrollTop).toBe(1200))
  expect(onFollowingTailChange).toHaveBeenLastCalledWith(true)
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()
})

test('always scrolls to the tail when a message is appended', async () => {
  const { rerender } = render(
    <ChatTranscript events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]} />,
  )
  const log = screen.getByRole('log', { name: 'Chat messages' })

  setScrollMetrics(log, { scrollTop: 120, scrollHeight: 1000, clientHeight: 400 })
  setScrollMetrics(log, { scrollTop: 120, scrollHeight: 1200, clientHeight: 400 })
  rerender(
    <ChatTranscript
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' }),
        event(2, 'agent.message.completed', 'assistant', 'completed', { text: 'Two' }),
      ]}
    />,
  )

  await waitFor(() => expect(log.scrollTop).toBe(1200))
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()
})

test('keeps auto-scroll active when content growth emits a scroll event', async () => {
  const { rerender } = render(
    <ChatTranscript events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]} />,
  )
  const log = screen.getByRole('log', { name: 'Chat messages' })

  setScrollMetrics(log, { scrollTop: 600, scrollHeight: 1200, clientHeight: 400 })
  fireEvent.scroll(log)

  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()

  rerender(
    <ChatTranscript
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' }),
        event(2, 'tool.call.started', 'assistant', 'started', { item_id: 'tool_1', command: 'pwd' }),
      ]}
    />,
  )

  await waitFor(() => expect(log.scrollTop).toBe(1200))
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()
})

test('keeps following the tail after a downward wheel gesture at the bottom', async () => {
  const onFollowingTailChange = vi.fn()
  const { rerender } = render(
    <ChatTranscript
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]}
      onFollowingTailChange={onFollowingTailChange}
    />,
  )
  const log = screen.getByRole('log', { name: 'Chat messages' })

  setScrollMetrics(log, { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })
  fireEvent.scroll(log)
  onFollowingTailChange.mockClear()
  fireEvent.wheel(log, { deltaY: 100 })

  expect(onFollowingTailChange).not.toHaveBeenCalledWith(false)
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()

  setScrollMetrics(log, { scrollTop: 600, scrollHeight: 1160, clientHeight: 400 })
  rerender(
    <ChatTranscript
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' }),
        event(2, 'agent.message.completed', 'assistant', 'completed', { text: 'Two' }),
      ]}
      onFollowingTailChange={onFollowingTailChange}
    />,
  )

  await waitFor(() => expect(log.scrollTop).toBe(1160))
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()
})

test('does not pause a downward gesture while streaming layout is temporarily off-bottom', async () => {
  const onFollowingTailChange = vi.fn()
  const { rerender } = render(
    <ChatTranscript
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]}
      onFollowingTailChange={onFollowingTailChange}
    />,
  )
  const log = screen.getByRole('log', { name: 'Chat messages' })

  setScrollMetrics(log, { scrollTop: 560, scrollHeight: 1000, clientHeight: 400 })
  fireEvent.scroll(log)
  onFollowingTailChange.mockClear()
  fireEvent.wheel(log, { deltaY: 80 })

  expect(onFollowingTailChange).not.toHaveBeenCalledWith(false)
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()

  setScrollMetrics(log, { scrollTop: 560, scrollHeight: 1180, clientHeight: 400 })
  rerender(
    <ChatTranscript
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' }),
        event(2, 'agent.message.delta', 'assistant', 'delta', { item_id: 'msg_2', text: 'Streaming' }),
      ]}
      onFollowingTailChange={onFollowingTailChange}
    />,
  )

  await waitFor(() => expect(log.scrollTop).toBe(1180))
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()
})

test('upward scrolling pauses even inside the generous bottom snap zone', () => {
  const onFollowingTailChange = vi.fn()
  render(
    <ChatTranscript
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]}
      onFollowingTailChange={onFollowingTailChange}
    />,
  )
  const log = screen.getByRole('log', { name: 'Chat messages' })
  setScrollMetrics(log, { scrollTop: 1390, scrollHeight: 2000, clientHeight: 400 })

  fireEvent.wheel(log, { deltaY: -80 })
  fireEvent.scroll(log)

  expect(onFollowingTailChange).toHaveBeenCalledWith(false)
  expect(screen.getByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).toBeInTheDocument()
})

test('downward scrolling resumes once it enters the generous bottom snap zone', async () => {
  const onFollowingTailChange = vi.fn()
  render(
    <ChatTranscript
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]}
      onFollowingTailChange={onFollowingTailChange}
    />,
  )
  const log = screen.getByRole('log', { name: 'Chat messages' })
  setScrollMetrics(log, { scrollTop: 1000, scrollHeight: 2000, clientHeight: 400 })
  fireEvent.wheel(log, { deltaY: -80 })
  fireEvent.scroll(log)

  fireEvent.wheel(log, { deltaY: 80 })
  setScrollMetrics(log, { scrollTop: 1300, scrollHeight: 2000, clientHeight: 400 })
  fireEvent.scroll(log)
  expect(screen.getByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).toBeInTheDocument()

  setScrollMetrics(log, { scrollTop: 1370, scrollHeight: 2000, clientHeight: 400 })
  fireEvent.scroll(log)

  expect(log.scrollTop).toBe(2000)
  expect(onFollowingTailChange).toHaveBeenLastCalledWith(true)
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()
})

test('scrollbar movement toward older content pauses an idle transcript', () => {
  const onFollowingTailChange = vi.fn()
  render(
    <ChatTranscript
      autoScroll={false}
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]}
      onFollowingTailChange={onFollowingTailChange}
    />,
  )
  const log = screen.getByRole('log', { name: 'Chat messages' })
  setScrollMetrics(log, { scrollTop: 1500, scrollHeight: 2000, clientHeight: 400 })
  fireEvent.pointerDown(log, { pointerType: 'mouse' })
  setScrollMetrics(log, { scrollTop: 900, scrollHeight: 2000, clientHeight: 400 })
  fireEvent.scroll(log)

  expect(onFollowingTailChange).toHaveBeenCalledWith(false)
  expect(screen.getByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).toBeInTheDocument()
})

test('programmatic upward scroll changes do not pause following', () => {
  const onFollowingTailChange = vi.fn()
  render(
    <ChatTranscript
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]}
      onFollowingTailChange={onFollowingTailChange}
    />,
  )
  const log = screen.getByRole('log', { name: 'Chat messages' })
  setScrollMetrics(log, { scrollTop: 600, scrollHeight: 1200, clientHeight: 400 })
  fireEvent.scroll(log)
  setScrollMetrics(log, { scrollTop: 560, scrollHeight: 1200, clientHeight: 400 })
  fireEvent.scroll(log)

  expect(onFollowingTailChange).not.toHaveBeenCalledWith(false)
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()
})

test('disables native overscroll so mobile rubber-banding cannot fight tail alignment', () => {
  render(
    <ChatTranscript
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]}
    />,
  )
  const log = screen.getByRole('log', { name: 'Chat messages' })
  expect(log).toHaveClass('overscroll-y-none')

  setScrollMetrics(log, { scrollTop: 700, scrollHeight: 1400, clientHeight: 400 })
  fireEvent.wheel(log, { deltaY: -100 })
  expect(log).toHaveClass('overscroll-y-none')
})

test('does not render a jump-to-latest control', () => {
  render(
    <ChatTranscript
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]}
    />,
  )
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()
})

test('delegates streaming tail growth to Virtuoso during a downward wheel gesture', async () => {
  const { rerender } = render(
    <ChatTranscript events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]} />,
  )
  const log = screen.getByRole('log', { name: 'Chat messages' })
  await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())))

  let scrollTop = 460
  let scrollWrites = 0
  Object.defineProperty(log, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value
      scrollWrites += 1
    },
  })
  Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 })
  Object.defineProperty(log, 'clientHeight', { configurable: true, value: 400 })

  fireEvent.wheel(log, { deltaY: 100 })
  fireEvent.scroll(log)
  Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1160 })
  rerender(
    <ChatTranscript
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' }),
        event(2, 'agent.message.delta', 'assistant', 'delta', { item_id: 'msg_2', text: 'Streaming' }),
      ]}
    />,
  )

  await waitFor(() => expect(scrollTop).toBe(1160))
  expect(scrollWrites).toBeGreaterThanOrEqual(1)
})

test('keeps the live tail buffered until jump to latest is clicked', async () => {
  const user = userEvent.setup()
  let resolveJump: () => void = () => undefined
  const onJumpToLatest = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveJump = resolve
      }),
  )
  const onFollowingTailChange = vi.fn()
  const { rerender } = render(
    <ChatTranscript
      hasNewerEvents
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'Older' })]}
      onJumpToLatest={onJumpToLatest}
      onFollowingTailChange={onFollowingTailChange}
    />,
  )
  const log = screen.getByRole('log', { name: 'Chat messages' })
  setScrollMetrics(log, { scrollTop: 120, scrollHeight: 1400, clientHeight: 400 })

  expect(onJumpToLatest).not.toHaveBeenCalled()
  const jumpButton = screen.getByRole('button', { name: 'Scroll to latest and resume auto-scroll' })
  await user.click(jumpButton)
  expect(onJumpToLatest).toHaveBeenCalledOnce()

  rerender(
    <ChatTranscript
      events={[event(2, 'agent.message.delta', 'assistant', 'delta', { item_id: 'msg_2', text: 'Live tail' })]}
      onJumpToLatest={onJumpToLatest}
      onFollowingTailChange={onFollowingTailChange}
    />,
  )
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()

  await act(async () => {
    resolveJump()
    await Promise.resolve()
  })
  await waitFor(() => expect(log.scrollTop).toBe(1400))
})

test('keeps live event tail alignment active in strict mode', async () => {
  const originalResizeObserver = globalThis.ResizeObserver
  const resizeCallbacks: ResizeObserverCallback[] = []
  class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback)
    }

    observe() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver

  try {
    const { rerender } = render(
      <StrictMode>
        <ChatTranscript events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]} />
      </StrictMode>,
    )
    const log = screen.getByRole('log', { name: 'Chat messages' })
    await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())))

    let scrollTop = 600
    let scrollWrites = 0
    Object.defineProperty(log, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
        scrollWrites += 1
      },
    })
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1160 })
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 400 })

    rerender(
      <StrictMode>
        <ChatTranscript
          events={[
            event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' }),
            event(2, 'agent.message.completed', 'assistant', 'completed', { text: 'Two' }),
          ]}
        />
      </StrictMode>,
    )
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)))
    await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())))

    expect(scrollWrites).toBeGreaterThanOrEqual(1)
    expect(scrollTop).toBe(1160)
  } finally {
    globalThis.ResizeObserver = originalResizeObserver
  }
})

test('scrolls to bottom when content grows while following latest', async () => {
  const { rerender } = render(
    <ChatTranscript
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]}
    />,
  )
  const log = screen.getByRole('log', { name: 'Chat messages' })

  setScrollMetrics(log, { scrollTop: 1000, scrollHeight: 1000, clientHeight: 400 })

  setScrollMetrics(log, { scrollTop: 1000, scrollHeight: 1160, clientHeight: 400 })
  rerender(
    <ChatTranscript
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' }),
        event(2, 'agent.message.completed', 'assistant', 'completed', { text: 'Two' }),
      ]}
    />,
  )

  await waitFor(() => expect(log.scrollTop).toBe(1160))
})

test('scrolls to bottom when the last virtual row grows while following latest', async () => {
  const { rerender } = render(
    <ChatTranscript
      events={[event(1, 'tool.call.started', 'assistant', 'started', { item_id: 'tool_1', command: 'go test ./...' })]}
    />,
  )
  const log = screen.getByRole('log', { name: 'Chat messages' })

  setScrollMetrics(log, { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })
  fireEvent.scroll(log)
  const initialRowCount = log.querySelectorAll('[data-index]').length

  setScrollMetrics(log, { scrollTop: 600, scrollHeight: 1160, clientHeight: 400 })
  rerender(
    <ChatTranscript
      events={[
        event(1, 'tool.call.started', 'assistant', 'started', { item_id: 'tool_1', command: 'go test ./...' }),
        event(2, 'tool.call.delta', 'assistant', 'delta', {
          item_id: 'tool_1',
          aggregated_output: 'ok\n'.repeat(40),
        }),
      ]}
    />,
  )

  expect(log.querySelectorAll('[data-index]')).toHaveLength(initialRowCount)
  await waitFor(() => expect(log.scrollTop).toBe(1160))
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()
})

test('scrolls to bottom when the bottom overlay inset grows while following latest', async () => {
  const { rerender } = render(
    <ChatTranscript
      bottomInsetHeight={176}
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]}
    />,
  )
  const log = screen.getByRole('log', { name: 'Chat messages' })

  setScrollMetrics(log, { scrollTop: 1000, scrollHeight: 1000, clientHeight: 400 })

  setScrollMetrics(log, { scrollTop: 1000, scrollHeight: 1160, clientHeight: 400 })
  rerender(
    <ChatTranscript
      bottomInsetHeight={336}
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]}
    />,
  )

  await waitFor(() => expect(log.scrollTop).toBe(1160))
})

test('renders first-load restored content in the virtual transcript', () => {
  render(
    <ChatTranscript
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'Restored answer' })]}
    />,
  )

  expect(screen.getByRole('log', { name: 'Chat messages' })).toContainElement(screen.getByText('Restored answer'))
})

test('observes virtual row growth so it can realign the tail', () => {
  const originalResizeObserver = globalThis.ResizeObserver
  const resizeObservers: ResizeObserverCallback[] = []
  class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeObservers.push(callback)
    }

    observe() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver

  try {
    render(
      <ChatTranscript
        bottomInsetHeight={176}
        events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'Restored answer' })]}
      />,
    )
    expect(resizeObservers).toHaveLength(1)
  } finally {
    globalThis.ResizeObserver = originalResizeObserver
  }
})

test('does not observe or align virtual row growth while the session is idle', async () => {
  const originalResizeObserver = globalThis.ResizeObserver
  const resizeObservers: ResizeObserverCallback[] = []
  class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeObservers.push(callback)
    }

    observe() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver

  try {
    const { rerender } = render(
      <ChatTranscript
        autoScroll={false}
        events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]}
      />,
    )
    const log = screen.getByRole('log', { name: 'Chat messages' })
    setScrollMetrics(log, { scrollTop: 120, scrollHeight: 1000, clientHeight: 400 })

    rerender(
      <ChatTranscript
        autoScroll={false}
        events={[
          event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' }),
          event(2, 'agent.message.completed', 'assistant', 'completed', { text: 'Two' }),
        ]}
      />,
    )
    await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())))

    expect(resizeObservers).toHaveLength(0)
    expect(log.scrollTop).toBe(120)
  } finally {
    globalThis.ResizeObserver = originalResizeObserver
  }
})

test('keeps a newly selected session pinned through its history refresh, then releases the pin', async () => {
  const initialEvents = [event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'Cached answer' })]
  const refreshedEvents = [
    ...initialEvents,
    event(2, 'agent.message.completed', 'assistant', 'completed', { text: 'Newest answer' }),
  ]
  const { rerender } = render(
    <ChatTranscript
      autoScroll={false}
      pinToLatestOnMount
      loading
      bottomInsetHeight={176}
      events={initialEvents}
    />,
  )
  const log = screen.getByRole('log', { name: 'Chat messages' })
  setScrollMetrics(log, { scrollTop: 120, scrollHeight: 1000, clientHeight: 400 })

  setScrollMetrics(log, { scrollTop: 120, scrollHeight: 1400, clientHeight: 400 })
  rerender(
    <ChatTranscript
      autoScroll={false}
      pinToLatestOnMount
      loading
      bottomInsetHeight={260}
      events={refreshedEvents}
    />,
  )
  await waitFor(() => expect(log.scrollTop).toBe(1400))

  setScrollMetrics(log, { scrollTop: 900, scrollHeight: 1500, clientHeight: 400 })
  rerender(
    <ChatTranscript
      autoScroll={false}
      pinToLatestOnMount
      bottomInsetHeight={260}
      events={refreshedEvents}
    />,
  )
  await waitFor(() => expect(log.scrollTop).toBe(1500))
  await act(async () => new Promise<void>((resolve) => window.setTimeout(resolve, 100)))

  setScrollMetrics(log, { scrollTop: 1500, scrollHeight: 1700, clientHeight: 400 })
  rerender(
    <ChatTranscript
      autoScroll={false}
      pinToLatestOnMount
      bottomInsetHeight={320}
      events={refreshedEvents}
    />,
  )
  await waitFor(() => expect(log.scrollTop).toBe(1700))
  await act(async () => new Promise<void>((resolve) => window.setTimeout(resolve, 250)))

  setScrollMetrics(log, { scrollTop: 600, scrollHeight: 1800, clientHeight: 400 })
  rerender(
    <ChatTranscript
      autoScroll={false}
      pinToLatestOnMount
      bottomInsetHeight={320}
      events={[
        ...refreshedEvents,
        event(3, 'agent.message.completed', 'assistant', 'completed', { text: 'Later idle event' }),
      ]}
    />,
  )
  await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())))
  expect(log.scrollTop).toBe(600)
})

test('performs one final tail alignment when the response becomes idle', () => {
  const queuedAlignments: FrameRequestCallback[] = []
  const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    queuedAlignments.push(callback)
    return queuedAlignments.length
  })
  const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)

  try {
    const { rerender } = render(
      <ChatTranscript
        events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]}
      />,
    )
    const log = screen.getByRole('log', { name: 'Chat messages' })
    setScrollMetrics(log, { scrollTop: 120, scrollHeight: 1000, clientHeight: 400 })

    rerender(
      <ChatTranscript
        autoScroll={false}
        events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]}
      />,
    )
    for (const alignment of queuedAlignments) alignment(0)

    expect(cancelFrame).not.toHaveBeenCalled()
    expect(log.scrollTop).toBe(1000)
  } finally {
    requestFrame.mockRestore()
    cancelFrame.mockRestore()
  }
})

test('keeps the viewport pinned after an upward wheel while content grows', async () => {
  const { rerender } = render(
    <ChatTranscript
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]}
    />,
  )
  const log = screen.getByRole('log', { name: 'Chat messages' })

  setScrollMetrics(log, { scrollTop: 120, scrollHeight: 1000, clientHeight: 400 })
  fireEvent.wheel(log, { deltaY: -100 })
  fireEvent.scroll(log)

  setScrollMetrics(log, { scrollTop: 120, scrollHeight: 1160, clientHeight: 400 })
  rerender(
    <ChatTranscript
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' }),
        event(2, 'agent.message.completed', 'assistant', 'completed', { text: 'Two' }),
      ]}
    />,
  )

  await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())))
  expect(log.scrollTop).toBe(120)
  expect(screen.getByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).toBeInTheDocument()
})

test('keeps the viewport pinned after an upward wheel while the bottom inset grows', async () => {
  const { rerender } = render(
    <ChatTranscript
      bottomInsetHeight={176}
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]}
    />,
  )
  const log = screen.getByRole('log', { name: 'Chat messages' })

  setScrollMetrics(log, { scrollTop: 120, scrollHeight: 1000, clientHeight: 400 })
  fireEvent.wheel(log, { deltaY: -100 })
  fireEvent.scroll(log)

  setScrollMetrics(log, { scrollTop: 120, scrollHeight: 1160, clientHeight: 400 })
  rerender(
    <ChatTranscript
      bottomInsetHeight={336}
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]}
    />,
  )

  await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())))
  expect(log.scrollTop).toBe(120)
  expect(screen.getByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).toBeInTheDocument()
})

test('copies fenced code blocks from user and assistant messages', async () => {
  const user = userEvent.setup()
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })

  render(
    <ChatTranscript
      events={[
        event(1, 'user.message.completed', 'user', 'completed', {
          text: 'Run this:\n\n```\nbun test\n```',
        }),
        event(2, 'agent.message.completed', 'assistant', 'completed', {
          text: 'Use this:\n\n```ts\nconst answer = 42\n```',
        }),
      ]}
    />,
  )

  const copyButtons = screen.getAllByRole('button', { name: 'Copy code' })
  expect(copyButtons).toHaveLength(2)

  await user.click(copyButtons[0])
  await user.click(copyButtons[1])

  expect(writeText).toHaveBeenNthCalledWith(1, expect.stringContaining('bun test'))
  expect(writeText).toHaveBeenNthCalledWith(2, expect.stringContaining('const answer = 42'))
})

test('shows an explicit error when code cannot be copied', async () => {
  const user = userEvent.setup()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => { throw new DOMException('Denied', 'NotAllowedError') }) },
  })
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: vi.fn(() => false),
  })

  render(
    <ChatTranscript
      events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: '```\nno copy\n```' })]}
    />,
  )

  await user.click(screen.getByRole('button', { name: 'Copy code' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Copy failed')
})

test('always shows the subtle message copy action, including while streaming', async () => {
  const user = userEvent.setup()
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })

  const { rerender } = render(
    <ChatTranscript
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', {
          text: 'Full answer body',
        }),
      ]}
    />,
  )

  expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Copy message' }))

  expect(writeText).toHaveBeenCalledWith('Full answer body')

  rerender(
    <ChatTranscript
      events={[event(1, 'agent.message.delta', 'assistant', 'delta', { text: 'Streaming body' })]}
    />,
  )

  expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument()
})

test('groups tool calls under assistant messages with expandable output', async () => {
  const user = userEvent.setup()
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })

  render(
    <ChatTranscript
      events={[
        event(1, 'user.message.completed', 'user', 'completed', { text: 'Run tests' }),
        event(2, 'tool.call.started', 'assistant', 'started', { item_id: 'tool_1', command: 'go test ./...' }),
        event(3, 'tool.call.completed', 'assistant', 'completed', { item_id: 'tool_1', output: 'ok' }),
        event(4, 'agent.message.completed', 'assistant', 'completed', { text: 'Tests passed.' }),
      ]}
    />,
  )

  expect(screen.getByText('Tests passed.')).toBeInTheDocument()
  expect(screen.queryByText('Tool Calls (1)')).not.toBeInTheDocument()
  expect(screen.getByText('go test ./...')).toBeInTheDocument()
  expect(screen.queryByText('completed')).not.toBeInTheDocument()
  expect(screen.queryByText(/go test \.\/\.\.\.\s+ok/)).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: /expand go test \.\/\.\.\./i }))

  expect(screen.getByText(/go test \.\/\.\.\.\s+ok/)).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Copy tool output' }))

  expect(writeText).toHaveBeenCalledWith('go test ./...\nok')
})

test('expands a running tool call from the chevron, status dot, label, and row', async () => {
  const user = userEvent.setup()

  render(
    <ChatTranscript
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'Checking channels.' }),
        event(2, 'tool.call.started', 'assistant', 'started', {
          item_id: 'tool_1',
          command: 'slackdump list channels',
        }),
      ]}
    />,
  )

  const row = screen.getByRole('button', { name: /expand slackdump list channels/i })
  const [chevron, statusDot, label] = Array.from(row.children) as HTMLElement[]

  expect(row).toHaveClass('h-5', 'touch-manipulation')
  expect(row.parentElement?.parentElement).not.toHaveClass('space-y-1')
  expect(chevron).toHaveClass('pointer-events-none')
  expect(statusDot).toHaveClass('pointer-events-none')
  expect(label).toHaveClass('pointer-events-none')

  await user.click(chevron)
  expect(row).toHaveAttribute('aria-expanded', 'true')
  await user.click(statusDot)
  expect(row).toHaveAttribute('aria-expanded', 'false')
  await user.click(label)
  expect(row).toHaveAttribute('aria-expanded', 'true')
  await user.click(row)
  expect(row).toHaveAttribute('aria-expanded', 'false')
})

test('opens file-change diffs in the file editor', async () => {
  const user = userEvent.setup()
  const onOpenFilePath = vi.fn()

  render(
    <ChatTranscript
      onOpenFilePath={onOpenFilePath}
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'Updating file.' }),
        event(2, 'file.change.completed', 'assistant', 'completed', {
          item_id: 'edit_1',
          paths: ['/repo/src/main.go'],
          changes: [
            {
              path: '/repo/src/main.go',
              patch: '@@ -1,2 +1,2 @@\n-old\n+new',
            },
          ],
        }),
      ]}
    />,
  )

  await user.click(screen.getByRole('button', { name: /expand main\.go/i }))
  expect(screen.getByText('-old')).toHaveClass('min-w-full', 'w-max')
  expect(screen.getByText('+new')).toHaveClass('min-w-full', 'w-max')
  await user.click(screen.getByRole('button', { name: 'Show in File Editor' }))

  expect(onOpenFilePath).toHaveBeenCalledWith('/repo/src/main.go')
})

test('shows codex command aggregated output in expandable tool output', async () => {
  const user = userEvent.setup()

  render(
    <ChatTranscript
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'Listing files.' }),
        event(2, 'tool.call.started', 'assistant', 'started', {
          item_id: 'tool_1',
          command: "/bin/zsh -lc 'ls -la'",
        }),
        event(3, 'tool.call.completed', 'assistant', 'completed', {
          item_id: 'tool_1',
          command: "/bin/zsh -lc 'ls -la'",
          aggregated_output: 'total 56\nREADME.md\nweb\n',
          exit_code: 0,
        }),
      ]}
    />,
  )

  expect(screen.getByText('ls -la')).toBeInTheDocument()
  expect(screen.queryByText(/README\.md/)).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: /expand ls -la/i }))

  expect(screen.getByText(/ls -la\s+total 56\s+README\.md\s+web/)).toBeInTheDocument()
})

test('expands historical nested MCP tool output', async () => {
  const user = userEvent.setup()

  render(
    <ChatTranscript
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'Running tests.' }),
        event(2, 'tool.call.started', 'assistant', 'started', {
          item_id: 'tool_1',
          item_type: 'mcpToolCall',
          server: 'life',
          tool: 'exec_command',
          arguments: { command: 'go test ./...', cwd: '/repo' },
        }),
        event(3, 'tool.call.completed', 'assistant', 'completed', {
          item_id: 'tool_1',
          item_type: 'mcpToolCall',
          server: 'life',
          tool: 'exec_command',
          arguments: { command: 'go test ./...', cwd: '/repo' },
          result: {
            content: [{ type: 'text', text: '{"output":"ok\\n"}' }],
            structuredContent: { output: 'ok\n' },
          },
        }),
      ]}
    />,
  )

  const row = screen.getByRole('button', { name: /expand go test/i })
  await user.click(row)

  expect(row).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText(/go test \.\/\.\.\.\s+ok/)).toBeInTheDocument()
})

test('renders MCP media and resource result blocks', async () => {
  const user = userEvent.setup()

  render(
    <ChatTranscript
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'Fetching artifacts.' }),
        event(2, 'tool.call.completed', 'assistant', 'completed', {
          item_id: 'tool_1',
          item_type: 'mcpToolCall',
          tool: 'fetch_artifacts',
          result: {
            content: [
              { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
              { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' },
              {
                type: 'resource',
                resource: { uri: 'mcp://files/report.pdf', blob: 'cGRm', mimeType: 'application/pdf' },
              },
              {
                type: 'resource_link',
                name: 'Reference',
                uri: 'https://example.com/reference',
                description: 'Supporting source',
                mimeType: 'text/html',
              },
            ],
          },
        }),
      ]}
    />,
  )

  await user.click(screen.getByRole('button', { name: /expand fetch_artifacts/i }))

  expect(screen.getByRole('button', { name: 'Preview image result' }).querySelector('img')).toHaveAttribute(
    'src',
    '/api/sessions/sess_1/events/2/tool-content/0',
  )
  expect(document.querySelector('audio')).toHaveAttribute('src', '/api/sessions/sess_1/events/2/tool-content/1')
  expect(screen.getByRole('link', { name: /report\.pdf/i })).toHaveAttribute(
    'href',
    '/api/sessions/sess_1/events/2/tool-content/2',
  )
  expect(screen.getByRole('link', { name: /Reference/i })).toHaveAttribute('href', 'https://example.com/reference')
  expect(screen.getByRole('link', { name: /Reference/i })).toHaveAttribute('target', '_blank')
})

test('does not show an expand affordance for a tool with no details', () => {
  render(
    <ChatTranscript
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'Waiting.' }),
        event(2, 'tool.call.completed', 'assistant', 'completed', {
          item_id: 'tool_1',
          item_type: 'collabAgentToolCall',
          tool: 'wait',
        }),
      ]}
    />,
  )

  const row = screen.getByRole('button', { name: 'wait' })
  expect(row).toBeDisabled()
  expect(row).not.toHaveAttribute('aria-expanded')
  expect(row.querySelector('svg')).not.toBeInTheDocument()
})

test('expands nested MCP error messages as failed tool output', async () => {
  const user = userEvent.setup()

  render(
    <ChatTranscript
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'Trying a tool.' }),
        event(2, 'tool.call.started', 'assistant', 'started', {
          item_id: 'tool_1',
          item_type: 'mcpToolCall',
          tool: 'unavailable_tool',
        }),
        event(3, 'tool.call.completed', 'assistant', 'failed', {
          item_id: 'tool_1',
          item_type: 'mcpToolCall',
          tool: 'unavailable_tool',
          error: { message: 'Tool unavailable', code: -32000 },
        }),
      ]}
    />,
  )

  await user.click(screen.getByRole('button', { name: /expand unavailable_tool/i }))

  expect(screen.getByText('Tool unavailable')).toHaveClass('text-destructive')
})

test('shows web search query details in expandable tool output', async () => {
  const user = userEvent.setup()

  render(
    <ChatTranscript
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'Checking weather.' }),
        event(2, 'tool.call.started', 'assistant', 'started', {
          item_id: 'web_1',
          item_type: 'webSearch',
          action: { type: 'other' },
          query: '',
        }),
        event(3, 'tool.call.completed', 'assistant', 'completed', {
          item_id: 'web_1',
          item_type: 'webSearch',
          action: {
            type: 'search',
            query: 'weather: 33445, United States',
            queries: ['weather: 33445, United States'],
          },
          query: 'weather: 33445, United States',
        }),
      ]}
    />,
  )

  expect(screen.getByText('Web search: weather: 33445, United States')).toBeInTheDocument()
  expect(screen.queryByText('Query: weather: 33445, United States')).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: /expand web search: weather: 33445/i }))

  expect(screen.getByText(/Query: weather: 33445, United States/)).toBeInTheDocument()
  expect(screen.getByText(/- weather: 33445, United States/)).toBeInTheDocument()
})

test('renders active tool indicators with the animated activity dot', () => {
  render(
    <ChatTranscript
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', { item_id: 'msg_1', text: 'Running a tool.' }),
        event(2, 'tool.call.started', 'assistant', 'started', {
          item_id: 'tool_1',
          command: 'sleep 20',
        }),
      ]}
    />,
  )

  const toolButton = screen.getByRole('button', { name: /expand sleep 20/i })
  expect(toolButton.querySelector('.tool-activity-dot')).toBeInTheDocument()
  expect(toolButton.querySelector('.animate-pulse')).not.toBeInTheDocument()
})

test('shows all tool calls for the latest message bubble', () => {
  const events = [
    event(1, 'agent.message.completed', 'assistant', 'completed', { item_id: 'msg_1', text: 'Working through tools.' }),
  ]
  for (let index = 1; index <= 5; index += 1) {
    events.push(
      event(index * 2, 'tool.call.started', 'assistant', 'started', {
        item_id: `tool_${index}`,
        command: `tool-${index}`,
      }),
      event(index * 2 + 1, 'tool.call.completed', 'assistant', 'completed', {
        item_id: `tool_${index}`,
        output: `output-${index}`,
      }),
    )
  }

  render(<ChatTranscript events={events} />)

  expect(screen.getByText('tool-1')).toBeInTheDocument()
  expect(screen.getByText('tool-3')).toBeInTheDocument()
  expect(screen.getByText('tool-4')).toBeInTheDocument()
  expect(screen.getByText('tool-5')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /show \d+ more/i })).not.toBeInTheDocument()
})

test('collapses extra tool calls after the next message bubble appears', async () => {
  const user = userEvent.setup()
  const events = [
    event(1, 'agent.message.completed', 'assistant', 'completed', { item_id: 'msg_1', text: 'Working through tools.' }),
  ]
  for (let index = 1; index <= 5; index += 1) {
    events.push(
      event(index * 2, 'tool.call.started', 'assistant', 'started', {
        item_id: `tool_${index}`,
        command: `tool-${index}`,
      }),
      event(index * 2 + 1, 'tool.call.completed', 'assistant', 'completed', {
        item_id: `tool_${index}`,
        output: `output-${index}`,
      }),
    )
  }
  events.push(
    event(20, 'agent.message.completed', 'assistant', 'completed', {
      item_id: 'msg_2',
      text: 'Done with the tools.',
    }),
  )

  render(<ChatTranscript events={events} />)

  expect(screen.queryByText('Tool Calls (5)')).not.toBeInTheDocument()
  expect(screen.getByText('tool-1')).toBeInTheDocument()
  expect(screen.getByText('tool-3')).toBeInTheDocument()
  expect(screen.queryByText('tool-4')).not.toBeInTheDocument()
  expect(screen.getByText('Done with the tools.')).toBeInTheDocument()
  const showMoreButton = screen.getByRole('button', { name: /show 2 more/i })
  expect(showMoreButton).toHaveClass('flex', 'min-h-6', 'w-fit', 'py-1', 'leading-4')
  expect(showMoreButton).not.toHaveClass('inline-flex', 'py-0', 'leading-none')

  await user.click(showMoreButton)

  expect(screen.getByText('tool-4')).toBeInTheDocument()
  expect(screen.getByText('tool-5')).toBeInTheDocument()
})

test('renders separate assistant items with sequential tools', () => {
  render(
    <ChatTranscript
      events={[
        event(1, 'user.message.completed', 'user', 'completed', { text: 'Split this into sections' }),
        event(2, 'agent.message.delta', 'assistant', 'delta', { item_id: 'msg_1', text: 'Section 1' }),
        event(3, 'agent.message.completed', 'assistant', 'completed', { item_id: 'msg_1', text: 'Section 1' }),
        event(4, 'tool.call.started', 'assistant', 'started', { item_id: 'tool_1', command: '/bin/zsh -lc pwd' }),
        event(5, 'tool.call.completed', 'assistant', 'completed', { item_id: 'tool_1', output: '/repo' }),
        event(6, 'agent.message.delta', 'assistant', 'delta', { item_id: 'msg_2', text: 'Section 2' }),
        event(7, 'agent.message.completed', 'assistant', 'completed', { item_id: 'msg_2', text: 'Section 2' }),
        event(8, 'tool.call.started', 'assistant', 'started', {
          item_id: 'tool_2',
          command: "/bin/zsh -lc 'git status --short'",
        }),
        event(9, 'tool.call.completed', 'assistant', 'completed', { item_id: 'tool_2', output: ' M file.ts' }),
      ]}
    />,
  )

  expect(screen.getByText('Section 1')).toBeInTheDocument()
  expect(screen.getByText('Section 2')).toBeInTheDocument()
  expect(screen.getByText('pwd')).toBeInTheDocument()
  expect(screen.getByText('git status --short')).toBeInTheDocument()
  expect(screen.queryByText(/\/bin\/zsh/)).not.toBeInTheDocument()
  expect(screen.queryByText('Assistant')).not.toBeInTheDocument()
})

test('renders streaming assistant messages without a badge', () => {
  render(
    <ChatTranscript
      events={[
        event(1, 'user.message.completed', 'user', 'completed', { text: 'Hello' }),
        event(2, 'agent.message.delta', 'assistant', 'delta', { text: 'Thinking' }),
      ]}
    />,
  )

  expect(screen.getByText('Thinking')).toBeInTheDocument()
  expect(screen.queryByText('Streaming')).not.toBeInTheDocument()
})

test('renders active thinking inline in the chat log', () => {
  render(
    <ChatTranscript
      activityStatus={{ kind: 'thinking' }}
      events={[event(1, 'user.message.completed', 'user', 'completed', { text: 'Hello' })]}
    />,
  )

  const thinkingStatus = screen.getByRole('status', { name: 'Thinking' })
  expect(thinkingStatus).toBeInTheDocument()
  expect(screen.getByRole('log', { name: 'Chat messages' })).toContainElement(thinkingStatus)
  expect(screen.getByText('Hello').compareDocumentPosition(thinkingStatus)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
})

test('renders active thinking instead of the empty transcript state', () => {
  render(<ChatTranscript activityStatus={{ kind: 'thinking' }} events={[]} />)

  expect(screen.getByRole('status', { name: 'Thinking' })).toBeInTheDocument()
  expect(screen.queryByText('No messages yet. Submit a prompt to start the chat.')).not.toBeInTheDocument()
})

test('previews image attachments in a dialog with download action', async () => {
  const user = userEvent.setup()
  render(
    <ChatTranscript
      events={[
        event(4, 'user.message.completed', 'user', 'completed', {
          text: 'see image',
          attachments: [
            {
              name: 'image.png',
              media_type: 'image/png',
              data_url: 'data:image/png;base64,[gorchestra truncated 100 bytes from this field for browser display]',
              size_bytes: 1234,
            },
          ],
        }),
      ]}
    />,
  )

  const thumbnail = screen.getByRole('button', { name: 'Preview image.png' })
  expect(screen.getByRole('img', { name: 'image.png' })).toHaveAttribute('src', '/api/sessions/sess_1/events/4/attachments/0')

  await user.click(thumbnail)

  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'image.png' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
    'href',
    '/api/sessions/sess_1/events/4/attachments/0',
  )
  expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('download', 'image.png')
})

test('hides debug-only events unless enabled', () => {
  render(
    <ChatTranscript
      events={[
        event(1, 'user.message.completed', 'user', 'completed', { text: 'Hello' }),
        event(2, 'session.status.updated', 'system', 'started', { status: 'running' }),
        event(3, 'agent.log.delta', 'system', 'delta', { text: 'debug line' }),
        event(4, 'agent.message.completed', 'assistant', 'completed', { text: 'Done' }),
      ]}
    />,
  )

  expect(screen.getByText('Hello')).toBeInTheDocument()
  expect(screen.getByText('Done')).toBeInTheDocument()
  expect(screen.queryByText('Session status')).not.toBeInTheDocument()
  expect(screen.queryByText('debug line')).not.toBeInTheDocument()
})

test('renders compact debug rows with expandable payloads', async () => {
  const user = userEvent.setup()
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })

  render(
    <ChatTranscript
      showDebugEvents
      events={[
        event(1, 'user.message.completed', 'user', 'completed', { text: 'Hello' }),
        event(2, 'session.status.updated', 'system', 'started', { status: 'running' }),
        event(3, 'agent.log.delta', 'system', 'delta', { text: 'debug line' }),
        event(4, 'agent.message.completed', 'assistant', 'completed', { text: 'Done' }),
      ]}
    />,
  )

  expect(screen.getByText('Session status')).toBeInTheDocument()
  expect(screen.getByText('Log')).toBeInTheDocument()
  expect(screen.getByText('debug line')).toBeInTheDocument()
  expect(screen.getByText('Session status').closest('article')?.parentElement).toHaveClass('mt-2')
  expect(screen.getByText('Log').closest('article')?.parentElement).toHaveClass('mt-1')

  await user.click(screen.getByRole('button', { name: /expand session status/i }))

  expect(screen.getByText(/"status": "running"/)).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Copy debug payload' }))

  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"status": "running"'))
})

test('labels provider debug rows with provider event type', () => {
  render(
    <ChatTranscript
      showDebugEvents
      events={[event(1, 'provider.codex.event', 'system', 'completed', { provider_event_type: 'turn/completed' })]}
    />,
  )

  expect(screen.getByText('turn/completed')).toBeInTheDocument()
  expect(screen.queryByText('provider.codex.event')).not.toBeInTheDocument()
})

function setScrollMetrics(
  element: HTMLElement,
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
) {
  Object.defineProperty(element, 'scrollTop', { configurable: true, writable: true, value: metrics.scrollTop })
  Object.defineProperty(element, 'scrollHeight', { configurable: true, writable: true, value: metrics.scrollHeight })
  Object.defineProperty(element, 'clientHeight', { configurable: true, writable: true, value: metrics.clientHeight })
}

function event(seq: number, type: string, role: string, status: string, payload: Record<string, unknown>): AgentEvent {
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
