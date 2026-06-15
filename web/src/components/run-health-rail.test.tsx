import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentEvent, Session } from '@/lib/api'
import { RunHealthRail } from '@/components/run-health-rail'

const session: Session = {
  id: 'sess_1',
  title: 'Inspect repo',
  agent_type: 'fake',
  status: 'running',
  workspace_path: '/repo',
  event_count: 1209,
  tool_count: 1209,
  created_at: '2026-06-12T16:00:00Z',
  updated_at: '2026-06-12T16:01:00Z',
  completed_at: null,
  archived_at: null,
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ root_path: '/repo', path: '', entries: [] }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

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
  expect(screen.getAllByText('1.2k')).toHaveLength(2)
  expect(screen.getByText('Agent message')).toBeInTheDocument()
  expect(screen.queryByText('Connection')).not.toBeInTheDocument()
  expect(screen.queryByText('Live')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Refresh files' })).toBeInTheDocument()
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

test('run health rail exposes codex clear and compact actions', async () => {
  const user = userEvent.setup()
  const onClear = vi.fn(async () => undefined)
  const onCompact = vi.fn(async () => undefined)

  render(
    <RunHealthRail
      session={{ ...session, agent_type: 'codex', status: 'idle', provider_session_id: 'thread_1' }}
      events={[]}
      streamState="connected"
      streamError=""
      onArchive={async () => undefined}
      onClear={onClear}
      onCompact={onCompact}
    />,
  )

  const tokenPanel = screen.getByText('Tokens').closest('section')
  expect(tokenPanel).toBeInTheDocument()
  expect(within(tokenPanel as HTMLElement).getByText('No token usage yet')).toBeInTheDocument()

  await user.click(within(tokenPanel as HTMLElement).getByRole('button', { name: 'Clear Codex context' }))
  await user.click(within(tokenPanel as HTMLElement).getByRole('button', { name: 'Compact Codex context' }))

  expect(onClear).toHaveBeenCalledOnce()
  expect(onCompact).toHaveBeenCalledOnce()
})

test('run health rail disables compact until a codex thread exists', () => {
  render(
    <RunHealthRail
      session={{ ...session, agent_type: 'codex', status: 'idle', provider_session_id: undefined }}
      events={[]}
      streamState="connected"
      streamError=""
      onArchive={async () => undefined}
    />,
  )

  expect(screen.getByRole('button', { name: 'Clear Codex context' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Compact Codex context' })).toBeDisabled()
})

test('run health rail latest event shows provider event type', () => {
  render(
    <RunHealthRail
      session={session}
      events={[event(1, 'provider.codex.event', 'system', 'completed', { provider_event_type: 'turn/completed' })]}
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
  expect(screen.getByText('14k / 258k current')).toBeInTheDocument()
  expect(screen.getByText('14k cumulative')).toBeInTheDocument()
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

test('run health rail file explorer refresh reloads the current folder', async () => {
  const user = userEvent.setup()
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    switch (String(url)) {
      case '/api/sessions/sess_1/files':
        return jsonResponse({
          root_path: '/repo',
          path: '',
          entries: [
            {
              name: 'src',
              path: 'src',
              type: 'directory',
              size_bytes: 0,
              modified_at: '2026-06-12T16:00:00Z',
            },
          ],
        })
      case '/api/sessions/sess_1/files?path=src':
        return jsonResponse({
          root_path: '/repo',
          path: 'src',
          entries: [
            {
              name: 'nested',
              path: 'src/nested',
              type: 'directory',
              size_bytes: 0,
              modified_at: '2026-06-12T16:00:00Z',
            },
          ],
        })
      default:
        throw new Error(`unexpected URL ${String(url)}`)
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  const requestedURLs = () => fetchMock.mock.calls.map(([url]) => String(url))

  render(
    <RunHealthRail
      session={session}
      events={[]}
      streamState="connected"
      streamError=""
      onArchive={async () => undefined}
    />,
  )

  await screen.findByRole('button', { name: 'src' })
  await user.click(screen.getByRole('button', { name: 'Refresh files' }))
  await waitFor(() => expect(requestedURLs().filter((url) => url === '/api/sessions/sess_1/files')).toHaveLength(2))

  await user.click(screen.getByRole('button', { name: 'src' }))
  await screen.findByRole('button', { name: 'nested' })
  await user.click(screen.getByRole('button', { name: 'Refresh files' }))
  await waitFor(() =>
    expect(requestedURLs().filter((url) => url === '/api/sessions/sess_1/files?path=src')).toHaveLength(2),
  )
})

test('run health rail file explorer dot folders hide at root and navigate from subfolders', async () => {
  const user = userEvent.setup()
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    switch (String(url)) {
      case '/api/sessions/sess_1/files':
        return jsonResponse({
          root_path: '/repo',
          path: '',
          entries: [
            {
              name: 'src',
              path: 'src',
              type: 'directory',
              size_bytes: 0,
              modified_at: '2026-06-12T16:00:00Z',
            },
          ],
        })
      case '/api/sessions/sess_1/files?path=src':
        return jsonResponse({
          root_path: '/repo',
          path: 'src',
          entries: [
            {
              name: 'nested',
              path: 'src/nested',
              type: 'directory',
              size_bytes: 0,
              modified_at: '2026-06-12T16:00:00Z',
            },
          ],
        })
      case '/api/sessions/sess_1/files?path=src%2Fnested':
        return jsonResponse({
          root_path: '/repo',
          path: 'src/nested',
          entries: [],
        })
      default:
        throw new Error(`unexpected URL ${String(url)}`)
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  const requestedURLs = () => fetchMock.mock.calls.map(([url]) => String(url))

  render(
    <RunHealthRail
      session={session}
      events={[]}
      streamState="connected"
      streamError=""
      onArchive={async () => undefined}
    />,
  )

  expect(await screen.findByRole('button', { name: 'src' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Go to parent folder' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Go to workspace root' })).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'src' }))
  expect(screen.getByRole('button', { name: 'Go to parent folder' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Go to workspace root' })).toBeInTheDocument()

  await user.click(await screen.findByRole('button', { name: 'nested' }))
  await waitFor(() => expect(requestedURLs()).toContain('/api/sessions/sess_1/files?path=src%2Fnested'))

  await user.click(screen.getByRole('button', { name: 'Go to parent folder' }))
  await waitFor(() =>
    expect(requestedURLs().filter((url) => url === '/api/sessions/sess_1/files?path=src')).toHaveLength(2),
  )

  await user.click(screen.getByRole('button', { name: 'Go to workspace root' }))
  await waitFor(() => expect(requestedURLs().filter((url) => url === '/api/sessions/sess_1/files')).toHaveLength(2))
  expect(screen.queryByRole('button', { name: 'Go to parent folder' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Go to workspace root' })).not.toBeInTheDocument()
})

test('run health rail file explorer searches file contents with snippets', async () => {
  const user = userEvent.setup()
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    switch (String(url)) {
      case '/api/sessions/sess_1/files':
        return jsonResponse({ root_path: '/repo', path: '', entries: [] })
      case '/api/sessions/sess_1/files/search?q=needle':
        return jsonResponse({
          query: 'needle',
          path: '',
          results: [
            {
              name: 'main.go',
              path: 'src/main.go',
              type: 'file',
              size_bytes: 48,
              modified_at: '2026-06-12T16:00:00Z',
              match_type: 'content',
              line_number: 4,
              line_text: 'println("needle")',
            },
          ],
        })
      default:
        throw new Error(`unexpected URL ${String(url)}`)
    }
  })
  vi.stubGlobal('fetch', fetchMock)

  render(
    <RunHealthRail
      session={session}
      events={[]}
      streamState="connected"
      streamError=""
      onArchive={async () => undefined}
    />,
  )

  await user.type(screen.getByRole('textbox', { name: 'Search files and contents' }), 'needle')

  expect(await screen.findByRole('button', { name: /main\.go/i })).toBeInTheDocument()
  expect(screen.getByText('src/main.go:4 println("needle")')).toBeInTheDocument()
})

test('run health rail file explorer sends file content to the viewer', async () => {
  const user = userEvent.setup()
  const onOpenFile = vi.fn()
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url) === '/api/sessions/sess_1/files') {
      return jsonResponse({
        root_path: '/repo',
        path: '',
        entries: [
          {
            name: 'main.go',
            path: 'main.go',
            type: 'file',
            size_bytes: 13,
            modified_at: '2026-06-12T16:00:00Z',
            git_status: 'modified',
          },
        ],
      })
    }
    if (String(url) === '/api/sessions/sess_1/files/content?path=main.go') {
      return jsonResponse({
        name: 'main.go',
        path: 'main.go',
        size_bytes: 13,
        modified_at: '2026-06-12T16:00:00Z',
        content: 'package main\n',
        encoding: 'utf-8',
        truncated: false,
        git_status: 'modified',
      })
    }
    throw new Error(`unexpected URL ${String(url)}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  render(
    <RunHealthRail
      session={session}
      events={[]}
      streamState="connected"
      streamError=""
      onArchive={async () => undefined}
      onOpenFile={onOpenFile}
    />,
  )

  await user.click(await screen.findByRole('button', { name: /main\.go/i }))

  await waitFor(() =>
    expect(onOpenFile).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'main.go',
        content: 'package main\n',
      }),
    ),
  )
  expect(screen.queryByText(/package main/)).not.toBeInTheDocument()
  expect(screen.getAllByText('M').length).toBeGreaterThan(0)
})

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

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
