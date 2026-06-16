import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentEvent } from '@/lib/api'
import { ChatTranscript } from '@/components/chat-transcript'

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
  expect(screen.getByText('Assistant')).toBeInTheDocument()
  expect(screen.queryByText('Hi thereHi there')).not.toBeInTheDocument()
  expect(container.querySelectorAll('time[datetime="2026-06-12T16:00:00Z"]')).toHaveLength(2)
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

  const assistantMessage = screen.getByText('Assistant').closest('article')
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

test('load older control invokes the older event loader', async () => {
  const user = userEvent.setup()
  const onLoadOlderEvents = vi.fn()

  render(
    <ChatTranscript
      hasOlderEvents
      onLoadOlderEvents={onLoadOlderEvents}
      events={[event(251, 'agent.message.completed', 'assistant', 'completed', { text: 'Tail' })]}
    />,
  )

  await user.click(screen.getByRole('button', { name: 'Load older events' }))

  expect(onLoadOlderEvents).toHaveBeenCalledTimes(1)
})

test('scrolling to the top auto-loads older events and leaves the manual button', async () => {
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
  fireEvent.scroll(log, { target: { scrollTop: 0 } })
  fireEvent.scroll(log, { target: { scrollTop: 0 } })

  await waitFor(() => expect(onLoadOlderEvents).toHaveBeenCalledTimes(1))
  expect(screen.getByRole('button', { name: 'Load older events' })).toBeInTheDocument()

  resolveLoad()
})

test('load older control is disabled while older events are loading', () => {
  render(
    <ChatTranscript
      hasOlderEvents
      loadingOlderEvents
      onLoadOlderEvents={() => undefined}
      events={[event(251, 'agent.message.completed', 'assistant', 'completed', { text: 'Tail' })]}
    />,
  )

  expect(screen.getByRole('button', { name: 'Load older events' })).toBeDisabled()
})

test('pauses auto-scroll when scrolled up and resumes from the latest pill', async () => {
  const user = userEvent.setup()
  const { rerender } = render(
    <ChatTranscript events={[event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' })]} />,
  )
  const log = screen.getByRole('log', { name: 'Chat messages' })

  setScrollMetrics(log, { scrollTop: 120, scrollHeight: 1000, clientHeight: 400 })
  fireEvent.wheel(log)
  fireEvent.scroll(log)

  expect(screen.getByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).toBeInTheDocument()

  setScrollMetrics(log, { scrollTop: 120, scrollHeight: 1200, clientHeight: 400 })
  rerender(
    <ChatTranscript
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' }),
        event(2, 'agent.message.completed', 'assistant', 'completed', { text: 'Two' }),
      ]}
    />,
  )

  expect(log.scrollTop).toBe(120)

  await user.click(screen.getByRole('button', { name: 'Scroll to latest and resume auto-scroll' }))

  expect(log.scrollTop).toBe(1200)
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()

  setScrollMetrics(log, { scrollTop: 1200, scrollHeight: 1400, clientHeight: 400 })
  rerender(
    <ChatTranscript
      events={[
        event(1, 'agent.message.completed', 'assistant', 'completed', { text: 'One' }),
        event(2, 'agent.message.completed', 'assistant', 'completed', { text: 'Two' }),
        event(3, 'agent.message.completed', 'assistant', 'completed', { text: 'Three' }),
      ]}
    />,
  )

  await waitFor(() => expect(log.scrollTop).toBe(1400))
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
  expect(screen.getByRole('button', { name: /show 2 more/i })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: /show 2 more/i }))

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
  expect(screen.getAllByText('Assistant')).toHaveLength(2)
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
      thinking
      events={[event(1, 'user.message.completed', 'user', 'completed', { text: 'Hello' })]}
    />,
  )

  const thinkingStatus = screen.getByRole('status', { name: 'Thinking' })
  expect(thinkingStatus).toBeInTheDocument()
  expect(screen.getByRole('log', { name: 'Chat messages' })).toContainElement(thinkingStatus)
  expect(screen.getByText('Hello').compareDocumentPosition(thinkingStatus)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
})

test('renders active thinking instead of the empty transcript state', () => {
  render(<ChatTranscript thinking events={[]} />)

  expect(screen.getByRole('status', { name: 'Thinking' })).toBeInTheDocument()
  expect(screen.queryByText('No messages yet. Submit a prompt to start the chat.')).not.toBeInTheDocument()
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
