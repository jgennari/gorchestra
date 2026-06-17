import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '@/App'
import type { AgentEvent, Session } from '@/lib/api'
import { clearSessionEventCacheForTest } from '@/hooks/use-session-events'

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value?: string; onChange?: (value: string | undefined) => void }) => (
    <textarea
      aria-label="File editor"
      value={value ?? ''}
      onChange={(event) => onChange?.(event.currentTarget.value)}
    />
  ),
}))

const firstSession = session('sess_1', 'Inspect repo', '2026-06-12T16:02:00Z')
const secondSession = session('sess_2', 'Write docs', '2026-06-12T16:01:00Z')

beforeEach(() => {
  window.history.replaceState({}, '', '/')
  window.localStorage.clear()
  clearSessionEventCacheForTest()
  document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />'
  FakeEventSource.instances = []
  vi.stubGlobal('fetch', fetchMock())
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('matchMedia', matchMediaMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('selecting a session updates the browser route', async () => {
  const user = userEvent.setup()

  render(<App />)

  await waitFor(() => expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0))
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/sess_1'))

  await user.click(screen.getAllByRole('button', { name: /Write docs/ })[0])

  await waitFor(() => expect(window.location.pathname).toBe('/sessions/sess_2'))
})

test('loading with a session route selects that session', async () => {
  window.history.replaceState({}, '', '/sessions/sess_2')

  render(<App />)

  await waitFor(() => expect(screen.getAllByText('Write docs').length).toBeGreaterThan(0))
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/sess_2'))
  expect(
    screen
      .getAllByRole('button', { name: /Write docs/ })
      .some((button) => button.getAttribute('aria-current') === 'true'),
  ).toBe(true)
})

test('archived filter reloads sessions including archived chats', async () => {
  const user = userEvent.setup()
  const archivedSession: Session = {
    ...session('sess_3', 'Archived chat', '2026-06-12T16:00:30Z'),
    agent_type: 'claude',
    archived_at: '2026-06-12T16:05:00Z',
  }
  const fetch = fetchMock({ sessions: [firstSession, secondSession, archivedSession] })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions?limit=50',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    ),
  )
  expect(screen.queryByText('Archived chat')).not.toBeInTheDocument()

  await user.click(screen.getAllByRole('button', { name: 'Session filters' })[0])
  await user.click(screen.getByLabelText('Show archived'))

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions?limit=50&include_archived=true',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    ),
  )
  expect(await screen.findByText('Archived chat')).toBeInTheDocument()
})

test('filter refreshes sessions in the background without showing a workspace loading bar', async () => {
  const user = userEvent.setup()
  const archivedSession: Session = {
    ...session('sess_3', 'Archived chat', '2026-06-12T16:00:30Z'),
    archived_at: '2026-06-12T16:05:00Z',
  }
  let resolveArchivedList: (() => void) | undefined
  const fetch = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path === '/api/health') {
      return jsonResponse({ status: 'ok' })
    }
    if (path === '/api/sessions?limit=50') {
      return jsonResponse({ sessions: [firstSession, secondSession] })
    }
    if (path === '/api/sessions?limit=50&include_archived=true') {
      await new Promise<void>((resolve) => {
        resolveArchivedList = resolve
      })
      return jsonResponse({ sessions: [firstSession, secondSession, archivedSession] })
    }
    if (path === '/api/sessions/sess_1') {
      return jsonResponse(firstSession)
    }
    if (path === '/api/sessions/sess_1/events?tail=true&limit=500') {
      return jsonResponse({ events: [] })
    }
    if (path === '/api/sessions/sess_2/events?tail=true&limit=500') {
      return jsonResponse({ events: [] })
    }
    throw new Error(`unexpected URL ${path}`)
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await waitFor(() => expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0))

  await user.click(screen.getAllByRole('button', { name: 'Session filters' })[0])
  await user.click(screen.getByLabelText('Show archived'))

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions?limit=50&include_archived=true',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    ),
  )
  expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0)
  expect(screen.queryByText('Loading sessions...')).not.toBeInTheDocument()

  await act(async () => {
    resolveArchivedList?.()
    await Promise.resolve()
  })
})

test('initial session load fetches the recent event window and streams after the tail', async () => {
  const fetch = fetchMock({
    events: [event(39, 'agent.message.delta', { text: 'Tail' }), event(40, 'agent.message.completed', { text: 'Tail' })],
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/sess_1/events?tail=true&limit=500',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    ),
  )
  await waitFor(() =>
    expect(FakeEventSource.instances.some((source) => source.url === '/api/sessions/sess_1/events/stream?after_seq=40'))
      .toBe(true),
  )
})

test('successful prompt submit reloads persisted events when the live stream is stale', async () => {
  const user = userEvent.setup()
  const fetch = fetchMock({
    events: [event(40, 'agent.message.completed', { text: 'Previous answer' })],
    submittedEvents: [
      event(40, 'agent.message.completed', { text: 'Previous answer' }),
      event(41, 'user.message.completed', { text: 'Fresh prompt' }),
    ],
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/sess_1/events?tail=true&limit=500',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    ),
  )
  expect(screen.queryByText('Fresh prompt')).not.toBeInTheDocument()

  await user.type(screen.getByPlaceholderText('Ask the agent to work on this repository...'), 'Fresh prompt{Enter}')

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/sess_1/messages',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Accept: 'application/json' }) }),
    ),
  )
  await waitFor(() =>
    expect(fetch.mock.calls.filter(([url]) => String(url) === '/api/sessions/sess_1/events?tail=true&limit=500')).toHaveLength(
      2,
    ),
  )
  expect(await screen.findByText('Fresh prompt')).toBeInTheDocument()
  expect(FakeEventSource.instances.some((source) => source.url === '/api/sessions/sess_1/events/stream?after_seq=41'))
    .toBe(true)
})

test('successful prompt submit keeps the current transcript visible while history refresh is pending', async () => {
  const user = userEvent.setup()
  let resolveRefresh: (() => void) | undefined
  let tailRequests = 0
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url)
    if (path === '/api/health') {
      return jsonResponse({ status: 'ok' })
    }
    if (path === '/api/sessions?limit=50') {
      return jsonResponse({ sessions: [firstSession, secondSession] })
    }
    if (path === '/api/sessions/sess_1') {
      return jsonResponse(firstSession)
    }
    if (path === '/api/sessions/sess_1/messages' && init?.method === 'POST') {
      return jsonResponse({ session_id: 'sess_1', status: 'running' })
    }
    if (path === '/api/sessions/sess_1/events?tail=true&limit=500') {
      tailRequests += 1
      if (tailRequests === 1) {
        return jsonResponse({ events: [event(40, 'user.message.completed', { text: 'Previous prompt' })] })
      }
      await new Promise<void>((resolve) => {
        resolveRefresh = resolve
      })
      return jsonResponse({
        events: [
          event(40, 'user.message.completed', { text: 'Previous prompt' }),
          event(41, 'user.message.completed', { text: 'Fresh prompt' }),
        ],
      })
    }
    throw new Error(`unexpected URL ${path}`)
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await waitFor(() => expect(screen.getByText('Previous prompt')).toBeInTheDocument())

  await user.type(screen.getByPlaceholderText('Ask the agent to work on this repository...'), 'Fresh prompt{Enter}')

  await waitFor(() => expect(tailRequests).toBe(2))
  expect(screen.getByText('Previous prompt')).toBeInTheDocument()
  expect(screen.queryByText('Loading chat history...')).not.toBeInTheDocument()

  await act(async () => {
    resolveRefresh?.()
    await Promise.resolve()
  })
  expect(await screen.findByText('Fresh prompt')).toBeInTheDocument()
  resolveRefresh?.()
})

test('switching back to a cached session restores transcript before replaying stream updates', async () => {
  const user = userEvent.setup()
  const fetch = fetchMock()
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  const initialSource = await findEventSource('/api/sessions/sess_1/events/stream?after_seq=0')
  act(() => {
    initialSource.emit(event(40, 'user.message.completed', { text: 'Cached prompt' }))
  })
  expect(await screen.findByText('Cached prompt')).toBeInTheDocument()

  await user.click(screen.getAllByRole('button', { name: /Write docs/ })[0])
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/sess_2'))

  await user.click(screen.getAllByRole('button', { name: /Inspect repo/ })[0])

  expect(screen.getByText('Cached prompt')).toBeInTheDocument()
  expect(screen.queryByText('Loading chat history...')).not.toBeInTheDocument()
  expect(
    fetch.mock.calls.filter(([url]) => String(url) === '/api/sessions/sess_1/events?tail=true&limit=500'),
  ).toHaveLength(1)

  await waitFor(() =>
    expect(
      FakeEventSource.instances.filter(
        (source) => source.url === '/api/sessions/sess_1/events/stream?after_seq=40',
      ),
    ).toHaveLength(1),
  )
  const replaySource = FakeEventSource.instances.filter(
    (source) => source.url === '/api/sessions/sess_1/events/stream?after_seq=40',
  ).at(-1)
  act(() => {
    replaySource?.emit(event(41, 'user.message.completed', { text: 'Replayed update' }))
  })

  expect(await screen.findByText('Replayed update')).toBeInTheDocument()
})

test('global activity stream marks another session pending input', async () => {
  const runningSecondSession: Session = { ...secondSession, status: 'running', last_event_seq: 4, event_count: 4 }
  vi.stubGlobal('fetch', fetchMock({ sessions: [firstSession, runningSecondSession] }))

  render(<App />)

  const activitySource = await findEventSource('/api/sessions/activity/stream')
  act(() => {
    activitySource.emit(
      event(5, 'agent.input.requested', { request_id: 'call_test', questions: [] }, 'sess_2'),
    )
  })

  expect(await screen.findByRole('img', { name: 'Session pending user input' })).toHaveClass(
    'animate-pulse',
    'bg-[hsl(var(--warning))]',
  )
  await waitFor(() => expect(faviconPath()).toBe('/favicon-notify.svg'))
})

test('global activity stream marks finished unselected sessions as unseen until selected', async () => {
  const runningSecondSession: Session = { ...secondSession, status: 'running', last_event_seq: 4, event_count: 4 }
  vi.stubGlobal('fetch', fetchMock({ sessions: [firstSession, runningSecondSession] }))
  const user = userEvent.setup()

  render(<App />)

  const activitySource = await findEventSource('/api/sessions/activity/stream')
  act(() => {
    activitySource.emit(
      event(5, 'session.status.updated', { status: 'idle', updated_at: '2026-06-12T16:12:00Z' }, 'sess_2'),
    )
  })

  expect(await screen.findByRole('img', { name: 'Session has unseen results' })).toHaveClass('bg-[hsl(var(--warning))]')
  await waitFor(() => expect(faviconPath()).toBe('/favicon-notify.svg'))

  await user.click(screen.getAllByRole('button', { name: /Write docs/ })[0])

  await waitFor(() => expect(screen.queryByRole('img', { name: 'Session has unseen results' })).not.toBeInTheDocument())
  await waitFor(() => expect(faviconPath()).toBe('/favicon.svg'))
})

test('global terminal events mark unselected sessions unseen even when seen state is stale', async () => {
  window.localStorage.setItem('gorchestra.session-seen-seq.v1', JSON.stringify({ sess_2: 5 }))
  const runningSecondSession: Session = { ...secondSession, status: 'running', last_event_seq: 4, event_count: 4 }
  vi.stubGlobal('fetch', fetchMock({ sessions: [firstSession, runningSecondSession] }))

  render(<App />)

  const activitySource = await findEventSource('/api/sessions/activity/stream')
  act(() => {
    activitySource.emit(
      event(5, 'agent.run.completed', { provider: 'codex', provider_event_type: 'turn/completed' }, 'sess_2'),
    )
  })

  expect(await screen.findByRole('img', { name: 'Session has unseen results' })).toHaveClass('bg-[hsl(var(--warning))]')
  await waitFor(() => expect(faviconPath()).toBe('/favicon-notify.svg'))
})

test('load older events fetches the previous event page', async () => {
  const user = userEvent.setup()
  const fetch = fetchMock({
    events: [event(251, 'agent.message.delta', { text: 'Tail' }), event(252, 'agent.message.completed', { text: 'Tail' })],
    olderEvents: [event(249, 'user.message.completed', { text: 'Older prompt' }), event(250, 'agent.message.completed', { text: 'Older answer' })],
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await user.click(await screen.findByRole('button', { name: 'Load older events' }))

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/sess_1/events?before_seq=251&limit=500',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    ),
  )
  expect(await screen.findByText('Older prompt')).toBeInTheDocument()
})

test('desktop pane resize handles update persisted widths', async () => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1600,
  })

  render(<App />)

  await waitFor(() => expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0))

  fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize sessions pane', hidden: true }), {
    key: 'ArrowRight',
  })
  fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize details pane', hidden: true }), {
    key: 'ArrowLeft',
  })

  await waitFor(() => {
    const stored = JSON.parse(window.localStorage.getItem('gorchestra.pane-widths.v1') ?? '{}') as {
      left?: number
      right?: number
    }
    expect(stored.left).toBe(364)
    expect(stored.right).toBe(360)
  })
})

test('file browser opens a chat overlay viewer that can close', async () => {
  const user = userEvent.setup()
  vi.stubGlobal('fetch', fetchMock({ fileEntry: true }))

  render(<App />)

  await user.click(await screen.findByRole('button', { name: /main\.go/i }))

  const dialog = await screen.findByRole('dialog', { name: 'File viewer: main.go' })
  expect(dialog).toBeInTheDocument()
  expect(within(dialog).getAllByText('main.go')).toHaveLength(1)
  expect(within(dialog).getByLabelText('File editor')).toHaveValue('package main\n')

  await user.click(screen.getByRole('button', { name: 'Close file viewer' }))

  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'File viewer: main.go' })).not.toBeInTheDocument())
})

test('file browser renders markdown files as markdown', async () => {
  const user = userEvent.setup()
  vi.stubGlobal(
    'fetch',
    fetchMock({ fileEntry: true, fileName: 'README.md', fileContent: '# Project Notes\n\n- Ship it' }),
  )

  render(<App />)

  await user.click(await screen.findByRole('button', { name: /README\.md/i }))

  const dialog = await screen.findByRole('dialog', { name: 'File viewer: README.md' })
  expect(dialog).toBeInTheDocument()
  expect(within(dialog).getAllByText('README.md')).toHaveLength(1)
  expect(within(dialog).getByRole('heading', { name: 'Project Notes' })).toBeInTheDocument()
  expect(within(dialog).getByRole('listitem')).toHaveTextContent('Ship it')
})

test('file browser edit mode saves workspace files', async () => {
  const user = userEvent.setup()
  vi.stubGlobal('fetch', fetchMock({ fileEntry: true, fileName: 'README.md', fileContent: '# Project Notes\n' }))

  render(<App />)

  await user.click(await screen.findByRole('button', { name: /README\.md/i }))
  const dialog = await screen.findByRole('dialog', { name: 'File viewer: README.md' })
  await user.click(within(dialog).getByRole('button', { name: /edit/i }))

  const editor = within(dialog).getByLabelText('File editor')
  await user.clear(editor)
  await user.type(editor, '# Edited Notes\n\nSaved')
  await user.click(within(dialog).getByRole('button', { name: /^save$/i }))

  await waitFor(() => expect(within(dialog).getByText('Saved')).toBeInTheDocument())
  await user.click(within(dialog).getByRole('button', { name: /preview/i }))

  expect(within(dialog).getByRole('heading', { name: 'Edited Notes' })).toBeInTheDocument()
  expect(within(dialog).getAllByText('Saved').length).toBeGreaterThan(0)
})

test('file change diff actions open absolute paths in the file editor', async () => {
  const user = userEvent.setup()
  vi.stubGlobal(
    'fetch',
    fetchMock({
      fileName: 'src/main.go',
      fileContent: 'package main\n',
      events: [
        event(1, 'file.change.completed', {
          item_id: 'edit_1',
          paths: ['/repo/src/main.go:12'],
          changes: [
            {
              path: '/repo/src/main.go:12',
              patch: '@@ -1,2 +1,2 @@\n-old\n+new',
            },
          ],
        }),
      ],
    }),
  )

  render(<App />)

  await user.click(await screen.findByRole('button', { name: /expand main\.go/i }))
  await user.click(screen.getByRole('button', { name: 'Show in File Editor' }))

  const dialog = await screen.findByRole('dialog', { name: 'File viewer: src/main.go' })
  expect(within(dialog).getByLabelText('File editor')).toHaveValue('package main\n')
})

test('streamed mutating git commands refresh the file browser', async () => {
  const fetch = fetchMock({ fileEntry: true })
  vi.stubGlobal('fetch', fetch)
  const requestedURLs = () => fetch.mock.calls.map(([url]) => String(url))

  render(<App />)

  await screen.findByRole('button', { name: /main\.go/i })
  await waitFor(() => expect(requestedURLs().filter((url) => url === '/api/sessions/sess_1/files')).toHaveLength(1))
  const sessionSource = await findEventSource('/api/sessions/sess_1/events/stream')

  act(() => {
    sessionSource.emit(
      event(41, 'tool.call.completed', {
        item_id: 'tool_1',
        item_type: 'commandExecution',
        command: "/bin/zsh -lc 'git pull --rebase'",
      }),
    )
  })

  await waitFor(() => expect(requestedURLs().filter((url) => url === '/api/sessions/sess_1/files')).toHaveLength(2))
})

test('codex session actions require dialog confirmation', async () => {
  const user = userEvent.setup()
  const codexSession: Session = { ...firstSession, agent_type: 'codex', provider_session_id: 'thread_1' }
  const fetch = fetchMock({ sessions: [codexSession, secondSession] })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await user.click(await screen.findByRole('button', { name: 'Compact Codex context' }))

  const dialog = await screen.findByRole('dialog', { name: 'Compact context?' })
  expect(dialog).toBeInTheDocument()
  expect(fetch).not.toHaveBeenCalledWith(
    '/api/sessions/sess_1/compact',
    expect.objectContaining({ method: 'POST' }),
  )

  await user.click(within(dialog).getByRole('button', { name: 'Compact' }))

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/sess_1/compact',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Accept: 'application/json' }) }),
    ),
  )
})

test('archive requires dialog confirmation', async () => {
  const user = userEvent.setup()
  const fetch = fetchMock()
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await user.click(await screen.findByRole('button', { name: 'Archive selected session' }))

  const dialog = await screen.findByRole('dialog', { name: 'Archive session?' })
  expect(dialog).toBeInTheDocument()
  expect(within(dialog).getByText('Inspect repo')).toBeInTheDocument()
  expect(fetch).not.toHaveBeenCalledWith(
    '/api/sessions/sess_1/archive',
    expect.objectContaining({ method: 'POST' }),
  )

  await user.click(within(dialog).getByRole('button', { name: 'Archive' }))

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/sess_1/archive',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Accept: 'application/json' }) }),
    ),
  )
})

function fetchMock({
  fileEntry = false,
  fileName = 'main.go',
  fileContent = 'package main\n',
  events = [],
  submittedEvents = events,
  olderEvents = [],
  sessions = [firstSession, secondSession],
}: {
  fileEntry?: boolean
  fileName?: string
  fileContent?: string
  events?: AgentEvent[]
  submittedEvents?: AgentEvent[]
  olderEvents?: AgentEvent[]
  sessions?: Session[]
} = {}) {
  let currentContent = fileContent
  let recentEvents = events
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url)
    if (path === '/api/health') {
      return jsonResponse({ status: 'ok' })
    }
    if (path === '/api/sessions?limit=50') {
      return jsonResponse({ sessions: sessions.filter((session) => !session.archived_at) })
    }
    if (path === '/api/sessions?limit=50&include_archived=true') {
      return jsonResponse({ sessions })
    }
    const sessionMatch = path.match(/^\/api\/sessions\/([^/?]+)$/)
    if (sessionMatch) {
      const matchedSession = sessions.find((session) => session.id === decodeURIComponent(sessionMatch[1]))
      if (matchedSession) {
        return jsonResponse(matchedSession)
      }
    }
    if (path === '/api/sessions/sess_1/clear' && init?.method === 'POST') {
      return jsonResponse({ session_id: 'sess_1', status: 'running' })
    }
    if (path === '/api/sessions/sess_1/compact' && init?.method === 'POST') {
      return jsonResponse({ session_id: 'sess_1', status: 'running' })
    }
    if (path === '/api/sessions/sess_1/messages' && init?.method === 'POST') {
      recentEvents = submittedEvents
      return jsonResponse({ session_id: 'sess_1', status: 'running' })
    }
    const archiveMatch = path.match(/^\/api\/sessions\/([^/?]+)\/archive$/)
    if (archiveMatch && init?.method === 'POST') {
      const matchedSession = sessions.find((session) => session.id === decodeURIComponent(archiveMatch[1]))
      if (matchedSession) {
        return jsonResponse({
          ...matchedSession,
          archived_at: '2026-06-12T16:05:00Z',
          updated_at: '2026-06-12T16:05:00Z',
        })
      }
    }
    if (path === '/api/sessions/sess_1/events?tail=true&limit=500') {
      return jsonResponse({ events: recentEvents })
    }
    if (path === '/api/sessions/sess_2/events?tail=true&limit=500') {
      return jsonResponse({ events: [] })
    }
    if (path === '/api/sessions/sess_1/events?before_seq=251&limit=500') {
      return jsonResponse({ events: olderEvents })
    }
    if (path === '/api/sessions/sess_1/files') {
      return jsonResponse({
        root_path: '/repo',
        path: '',
        entries: fileEntry
          ? [
              {
                name: fileName,
                path: fileName,
                type: 'file',
                size_bytes: fileContent.length,
                modified_at: '2026-06-12T16:00:00Z',
              },
            ]
          : [],
      })
    }
    if (path === '/api/sessions/sess_2/files') {
      return jsonResponse({ root_path: '/repo', path: '', entries: [] })
    }
    if (path === `/api/sessions/sess_1/files/content?path=${encodeURIComponent(fileName)}`) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { content?: string }
        currentContent = body.content ?? ''
        return jsonResponse({
          name: fileName,
          path: fileName,
          size_bytes: currentContent.length,
          modified_at: '2026-06-12T16:00:00Z',
          content: currentContent,
          encoding: 'utf-8',
          truncated: false,
        })
      }
      return jsonResponse({
        name: fileName,
        path: fileName,
        size_bytes: currentContent.length,
        modified_at: '2026-06-12T16:00:00Z',
        content: currentContent,
        encoding: 'utf-8',
        truncated: false,
      })
    }
    throw new Error(`unexpected URL ${path}`)
  })
}

class FakeEventSource {
  static instances: FakeEventSource[] = []

  url: string
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  private listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
    window.setTimeout(() => this.onopen?.(new Event('open')), 0)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const nextListeners = this.listeners.get(type) ?? []
    nextListeners.push((event) => {
      if (typeof listener === 'function') {
        listener(event)
      } else {
        listener.handleEvent(event)
      }
    })
    this.listeners.set(type, nextListeners)
  }

  emit(event: AgentEvent) {
    const message = new MessageEvent(event.type, { data: JSON.stringify(event) })
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(message)
    }
  }

  close() {}
}

async function findEventSource(urlPrefix: string) {
  await waitFor(() => expect(findExistingEventSource(urlPrefix)).toBeTruthy())
  return findExistingEventSource(urlPrefix)!
}

function findExistingEventSource(urlPrefix: string) {
  return FakeEventSource.instances.find((source) => source.url.startsWith(urlPrefix))
}

function matchMediaMock(query: string): MediaQueryList {
  return {
    media: query,
    matches: false,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }
}

function faviconPath() {
  const href = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href
  return href ? new URL(href).pathname : ''
}

function session(id: string, title: string, updatedAt: string): Session {
  return {
    id,
    title,
    agent_type: 'fake',
    status: 'idle',
    workspace_path: '/repo',
    event_count: 0,
    tool_count: 0,
    created_at: '2026-06-12T16:00:00Z',
    updated_at: updatedAt,
    completed_at: null,
    archived_at: null,
  }
}

function event(seq: number, type: string, payload: Record<string, unknown>, sessionID = 'sess_1'): AgentEvent {
  return {
    id: `evt_${seq}`,
    session_id: sessionID,
    seq,
    type,
    role: 'assistant',
    status: 'completed',
    payload,
    created_at: '2026-06-12T16:00:00Z',
  }
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
