import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '@/App'
import type { AgentEvent, Session } from '@/lib/api'
import { clearSessionEventCacheForTest } from '@/hooks/use-session-events'
import { readCachedSessionEvents, writeCachedSession, writeCachedSessionEvents } from '@/lib/session-cache'
import { createFakeIndexedDB } from '@/test/fake-indexeddb'
import {
  clearNotificationAttentionCacheForTest,
  writeNotificationAttention,
} from '@/lib/notification-attention'

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value?: string; onChange?: (value: string | undefined) => void }) => (
    <textarea
      aria-label="File editor"
      value={value ?? ''}
      onChange={(event) => onChange?.(event.currentTarget.value)}
    />
  ),
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24

    loadAddon() {}
    open() {}
    write() {}
    dispose() {}
    onData() {
      return { dispose() {} }
    }
  },
}))

const firstSession = session('sess_1', 'Inspect repo', '2026-06-12T16:02:00Z')
const secondSession = session('sess_2', 'Write docs', '2026-06-12T16:01:00Z')

beforeEach(() => {
  window.history.replaceState({}, '', '/sessions/sess_1')
  window.localStorage.clear()
  clearSessionEventCacheForTest()
  clearNotificationAttentionCacheForTest()
  document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />'
  FakeEventSource.instances = []
  vi.stubGlobal('fetch', fetchMock())
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('matchMedia', matchMediaMock)
})

test('uses a selected session from the initial list without refetching its detail', async () => {
  const fetch = fetchMock()
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await waitFor(() => expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0))
  expect(fetch.mock.calls.filter(([url]) => String(url) === '/api/sessions/sess_1')).toHaveLength(0)
})

test('global activity excludes the selected session', async () => {
  render(<App />)

  const activitySource = await findEventSource('/api/sessions/activity/stream')
  expect(activitySource.url).toBe('/api/sessions/activity/stream?exclude_session_id=sess_1')
})

test('overview coalesces an activity burst into one dashboard refresh', async () => {
  window.history.replaceState({}, '', '/')
  const fetch = fetchMock()
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  const activitySource = await findEventSource('/api/sessions/activity/stream')
  await waitFor(() => {
    expect(fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/dashboard?'))).toHaveLength(1)
    expect(fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/dashboard/runs?'))).toHaveLength(1)
  })

  act(() => {
    for (let seq = 10; seq < 20; seq += 1) {
      activitySource.emit(event(seq, 'agent.message.delta', { text: `chunk ${seq}` }, 'sess_2'))
    }
  })

  await waitFor(
    () => {
      expect(fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/dashboard?'))).toHaveLength(2)
      expect(fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/dashboard/runs?'))).toHaveLength(2)
    },
    { timeout: 2000 },
  )
})

test('global activity reconnects before reconciling the session list once', async () => {
  const fetch = fetchMock()
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  const activitySource = await findEventSource('/api/sessions/activity/stream')
  await waitFor(() =>
    expect(fetch.mock.calls.filter(([url]) => String(url) === '/api/sessions?limit=50')).toHaveLength(1),
  )

  act(() => activitySource.fail())
  expect(fetch.mock.calls.filter(([url]) => String(url) === '/api/sessions?limit=50')).toHaveLength(1)

  await waitFor(
    () => {
      expect(FakeEventSource.instances.filter((source) => source.url.startsWith('/api/sessions/activity/stream')))
        .toHaveLength(2)
      expect(fetch.mock.calls.filter(([url]) => String(url) === '/api/sessions?limit=50')).toHaveLength(2)
    },
    { timeout: 2500 },
  )
})

test('notification launch keeps the selected finished session unseen until deliberately selected', async () => {
  const user = userEvent.setup()
  const setAppBadge = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: setAppBadge })
  vi.stubGlobal('indexedDB', createFakeIndexedDB())
  window.history.replaceState({}, '', '/sessions/sess_1?notification_seq=5')
  vi.stubGlobal('fetch', fetchMock({
    sessions: [{ ...firstSession, last_event_seq: 5, event_count: 5 }],
    events: [event(5, 'agent.run.completed', {})],
  }))

  render(<App />)

  await waitFor(() =>
    expect(screen.getByRole('img', { name: 'Session has unseen results' })).toHaveClass('bg-[hsl(var(--warning))]'),
  )
  await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(1))
  expect(window.location.search).not.toContain('notification_seq')

  await user.click(screen.getAllByRole('button', { name: /Inspect repo/ })[0])

  await waitFor(() => expect(screen.queryByRole('img', { name: 'Session has unseen results' })).not.toBeInTheDocument())
  await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(0))
})

test('background notification attention survives app launch for the selected session', async () => {
  const setAppBadge = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: setAppBadge })
  vi.stubGlobal('indexedDB', createFakeIndexedDB())
  await writeNotificationAttention('sess_1', 5)
  window.history.replaceState({}, '', '/sessions/sess_1')
  vi.stubGlobal('fetch', fetchMock({
    sessions: [{ ...firstSession, last_event_seq: 5, event_count: 5 }],
    events: [event(5, 'agent.run.completed', {})],
  }))

  render(<App />)

  await waitFor(() =>
    expect(screen.getByRole('img', { name: 'Session has unseen results' })).toHaveClass('bg-[hsl(var(--warning))]'),
  )
  await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(1))
})

test('server notification attention survives app launch for the selected session', async () => {
  const user = userEvent.setup()
  const setAppBadge = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: setAppBadge })
  window.history.replaceState({}, '', '/sessions/sess_1')
  const fetch = fetchMock({
    sessions: [{ ...firstSession, event_count: 5, last_event_seq: 5, notification_attention_seq: 5 }],
    events: [event(5, 'agent.run.completed', {})],
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await waitFor(() =>
    expect(screen.getByRole('img', { name: 'Session has unseen results' })).toHaveClass('bg-[hsl(var(--warning))]'),
  )
  await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(1))

  await user.click(screen.getAllByRole('button', { name: /Inspect repo/ })[0])

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/sess_1/notification-attention/clear',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Accept: 'application/json' }) }),
    ),
  )
  await waitFor(() => expect(screen.queryByRole('img', { name: 'Session has unseen results' })).not.toBeInTheDocument())
  await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(0))
})

test('focusing the composer clears finished-turn notification attention', async () => {
  const user = userEvent.setup()
  const setAppBadge = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: setAppBadge })
  window.history.replaceState({}, '', '/sessions/sess_1')
  const fetch = fetchMock({
    sessions: [{ ...firstSession, event_count: 5, last_event_seq: 5, notification_attention_seq: 5 }],
    events: [event(5, 'agent.run.completed', {})],
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await waitFor(() =>
    expect(screen.getByRole('img', { name: 'Session has unseen results' })).toHaveClass('bg-[hsl(var(--warning))]'),
  )

  await user.click(screen.getByRole('textbox', { name: 'Prompt' }))

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/sess_1/notification-attention/clear',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Accept: 'application/json' }) }),
    ),
  )
  await waitFor(() => expect(screen.queryByRole('img', { name: 'Session has unseen results' })).not.toBeInTheDocument())
  await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(0))
})

test('dismiss all notifications clears every unseen session without opening them', async () => {
  const user = userEvent.setup()
  const setAppBadge = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: setAppBadge })
  const fetch = fetchMock({
    sessions: [
      { ...firstSession, event_count: 5, last_event_seq: 5, notification_attention_seq: 5 },
      { ...secondSession, event_count: 7, last_event_seq: 7, notification_attention_seq: 7 },
    ],
    events: [event(5, 'agent.run.completed', {})],
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await waitFor(() => expect(screen.getAllByRole('img', { name: 'Session has unseen results' })).toHaveLength(2))
  await user.click(screen.getByRole('button', { name: 'Notifications, 2 unread' }))
  await user.click(screen.getByRole('menuitem', { name: 'Dismiss all notifications' }))

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/notification-attention/clear',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Accept: 'application/json' }) }),
    ),
  )
  expect(screen.queryByRole('img', { name: 'Session has unseen results' })).not.toBeInTheDocument()
  expect(screen.queryByRole('menuitem', { name: 'Dismiss all notifications' })).not.toBeInTheDocument()
  await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(0))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('selecting a session updates the browser route', async () => {
  const user = userEvent.setup()
  window.history.replaceState({}, '', '/')

  render(<App />)

  expect(await screen.findByRole('heading', { name: 'Your work at a glance' })).toBeInTheDocument()
  expect(window.location.pathname).toBe('/')

  await user.click(screen.getAllByRole('button', { name: /Write docs/ })[0])

  await waitFor(() => expect(window.location.pathname).toBe('/sessions/write-docs'))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveFocus())
})

test('switching app views updates the session route and browser history', async () => {
  const user = userEvent.setup()

  render(<App />)

  await waitFor(() => expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0))
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/inspect-repo'))

  await user.click(screen.getAllByRole('button', { name: 'Show console' })[0])
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/inspect-repo/console'))
  expect(
    screen
      .getAllByRole('button', { name: 'Show console' })
      .some((button) => button.getAttribute('aria-pressed') === 'true'),
  ).toBe(true)

  await user.click(screen.getAllByRole('button', { name: 'Show files' })[0])
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/inspect-repo/files'))
  expect(
    screen
      .getAllByRole('button', { name: 'Show files' })
      .some((button) => button.getAttribute('aria-pressed') === 'true'),
  ).toBe(true)

  await act(async () => {
    window.history.back()
    await waitFor(() => expect(window.location.pathname).toBe('/sessions/inspect-repo/console'))
  })
  expect(
    screen
      .getAllByRole('button', { name: 'Show console' })
      .some((button) => button.getAttribute('aria-pressed') === 'true'),
  ).toBe(true)

  await act(async () => {
    window.history.back()
    await waitFor(() => expect(window.location.pathname).toBe('/sessions/inspect-repo'))
  })
  expect(
    screen
      .getAllByRole('button', { name: 'Show chat' })
      .some((button) => button.getAttribute('aria-pressed') === 'true'),
  ).toBe(true)
})

test('the desktop rail picker persists its selected utility', async () => {
  const user = userEvent.setup()
  render(<App />)

  await user.click(await screen.findByRole('button', { name: 'Rail content: Files' }))
  await user.click(screen.getByRole('menuitemradio', { name: 'Blocks' }))

  await waitFor(() => expect(window.localStorage.getItem('gorchestra.rail-content.v1')).toBe('blocks'))
  expect(screen.getByRole('region', { name: 'Blocks game' })).toBeInTheDocument()
  expect(screen.getByText('Activity')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Archive selected session' })).toBeInTheDocument()
})

test('a conversation map segment opens chat at its event sequence', async () => {
  const user = userEvent.setup()
  const events = [
    { ...event(1, 'user.message.completed', { text: 'Inspect the build' }), role: 'user' },
    event(2, 'agent.message.completed', { text: 'The build passes.' }),
  ]
  window.localStorage.setItem('gorchestra.rail-content.v1', 'conversation-map')
  const baseFetch = fetchMock({ events })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === '/api/sessions/sess_1/events?around_seq=2&turns=2&max_bytes=1048576') {
        return jsonResponse({
          events,
          page: {
            first_seq: 1,
            last_seq: 2,
            server_last_seq: 2,
            has_older: false,
            has_newer: true,
            starts_mid_turn: false,
            ends_mid_turn: false,
          },
        })
      }
      return baseFetch(url, init)
    }),
  )

  render(<App />)
  await user.click(await screen.findByRole('button', { name: /Open Agent response · #2/ }))

  await waitFor(() => expect(window.location.pathname).toBe('/sessions/inspect-repo'))
  expect(window.location.search).toBe('?event_seq=2')
  expect(screen.getByText('The build passes.').closest('[data-transcript-row]')).toHaveClass(
    'mx-2',
    'ring-2',
    'ring-inset',
  )

  await user.click(screen.getByRole('button', { name: 'Jump conversation map to latest' }))
  await waitFor(() => expect(window.location.search).toBe(''))
})

test('loading with console and files routes restores the routed app view', async () => {
  window.history.replaceState({}, '', '/sessions/sess_1/files')
  const firstRender = render(<App />)

  await waitFor(() => expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0))
  expect(
    screen
      .getAllByRole('button', { name: 'Show files' })
      .some((button) => button.getAttribute('aria-pressed') === 'true'),
  ).toBe(true)

  firstRender.unmount()
  window.history.replaceState({}, '', '/sessions/sess_1/console')
  render(<App />)

  await waitFor(() =>
    expect(
      screen
        .getAllByRole('button', { name: 'Show console' })
        .some((button) => button.getAttribute('aria-pressed') === 'true'),
    ).toBe(true),
  )
})

test('mobile navigation uses the floating session header', async () => {
  render(<App />)

  await waitFor(() => expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0))

  const openSessionsButton = screen.getByRole('button', { name: 'Open sessions' })
  expect(openSessionsButton.closest('.mobile-floating-header-shell')).toBeTruthy()
  expect(document.querySelector('.mobile-app-header')).toBeNull()
})

test('mobile sessions button opens a floating session dialog', async () => {
  const user = userEvent.setup()

  render(<App />)

  await waitFor(() => expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0))

  await user.click(screen.getByRole('button', { name: 'Open sessions' }))

  const dialog = await screen.findByRole('dialog', { name: 'Sessions' })
  expect(within(dialog).getByRole('button', { name: 'Create session' })).toBeInTheDocument()
  expect(within(dialog).getByRole('button', { name: 'App menu' })).toBeInTheDocument()
  expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument()

  await user.click(within(dialog).getByRole('button', { name: /Write docs/ }))

  await waitFor(() => expect(window.location.pathname).toBe('/sessions/write-docs'))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sessions' })).not.toBeInTheDocument())
})

test('mobile session menu opens workspace details in a floating dialog', async () => {
  const user = userEvent.setup()
  vi.stubGlobal('fetch', fetchMock({ fileEntry: true }))

  render(<App />)

  await waitFor(() => expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0))
  const mobileHeader = screen.getByTestId('mobile-floating-session-header')

  await user.click(within(mobileHeader).getByRole('button', { name: 'More session actions' }))
  await user.click(within(mobileHeader).getByRole('menuitem', { name: 'Workspace details' }))

  const dialog = await screen.findByRole('dialog', { name: 'Workspace details' })
  expect(within(dialog).getByText('Activity')).toBeInTheDocument()
  expect(within(dialog).queryByText('Files')).not.toBeInTheDocument()
  expect(within(dialog).queryByRole('button', { name: /main\.go/i })).not.toBeInTheDocument()
})

test('header files view opens workspace files inline', async () => {
  const user = userEvent.setup()
  vi.stubGlobal('fetch', fetchMock({ fileEntry: true }))

  render(<App />)

  await waitFor(() => expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0))

  await user.click(screen.getAllByRole('button', { name: 'Show files' })[0])
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/inspect-repo/files'))
  const filesHeader = screen.getByTestId('floating-files-header')
  expect(within(filesHeader).getByRole('button', { name: 'Show session settings' })).toBeInTheDocument()
  expect(screen.getByText('No file selected').closest('.host-console-frame')).toBeTruthy()

  await user.click((await screen.findAllByRole('button', { name: /main\.go/i }))[0])

  const fileViewer = await screen.findByRole('region', { name: 'File viewer: main.go' })
  expect(within(fileViewer).getByLabelText('File editor')).toHaveValue('package main\n')
})

test('header hosted preview view updates the route and shows host status', async () => {
  const user = userEvent.setup()

  render(<App />)

  await waitFor(() => expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0))
  await user.click(screen.getAllByRole('button', { name: 'Show hosted preview' })[0])

  await waitFor(() => expect(window.location.pathname).toBe('/sessions/inspect-repo/host'))
  expect(await screen.findByText('No host recipe found')).toBeInTheDocument()
  expect(within(screen.getByTestId('floating-host-header')).getByRole('button', { name: 'Show session settings' })).toBeInTheDocument()
  expect(
    screen
      .getAllByRole('button', { name: 'Show hosted preview' })
      .some((button) => button.getAttribute('aria-pressed') === 'true'),
  ).toBe(true)
})

test('schedules view uses the shared floating session header', async () => {
  const user = userEvent.setup()

  render(<App />)

  await waitFor(() => expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0))
  await user.click(screen.getAllByRole('button', { name: 'Show schedules' })[0])

  await waitFor(() => expect(window.location.pathname).toBe('/sessions/inspect-repo/schedules'))
  const schedulesHeader = screen.getByTestId('floating-schedules-header')
  expect(within(schedulesHeader).getByRole('button', { name: 'Show session settings' })).toBeInTheDocument()
  expect(schedulesHeader.querySelector('.command-chat-header')).toBeInTheDocument()
  const scheduleInfo = screen.getByRole('heading', { name: 'Scheduled tasks' }).closest('section')
  expect(scheduleInfo).toHaveClass('rounded-lg', 'border', 'bg-background/72', 'shadow-sm')
  expect(scheduleInfo?.closest('.session-schedules-body')).toBeTruthy()
})

test('session settings is a routed card page and mobile views live in an overflow menu', async () => {
  const user = userEvent.setup()

  render(<App />)

  await waitFor(() => expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0))
  const mobileHeader = screen.getByTestId('mobile-floating-session-header')
  expect(within(mobileHeader).queryByRole('button', { name: 'Session settings' })).not.toBeInTheDocument()

  await user.click(within(mobileHeader).getByRole('button', { name: 'More session actions' }))
  await user.click(within(mobileHeader).getByRole('menuitem', { name: 'Session settings' }))

  await waitFor(() => expect(window.location.pathname).toBe('/sessions/inspect-repo/settings'))
  const card = screen.getByRole('heading', { name: 'Session settings' }).closest('section')
  expect(card).toHaveClass('rounded-lg', 'border', 'bg-background/72', 'shadow-sm')
  expect(card?.closest('.session-settings-body')).toBeTruthy()
  expect(screen.getByTestId('floating-settings-header')).toBeInTheDocument()
})

test('repository skills view uses the shared floating session header and information card', async () => {
  const user = userEvent.setup()
  render(<App />)
  await waitFor(() => expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0))
  await user.click(screen.getAllByRole('button', { name: 'Show repository skills' })[0])
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/inspect-repo/skills'))
  const skillsHeader = screen.getByTestId('floating-skills-header')
  expect(within(skillsHeader).getByRole('button', { name: 'Show session settings' })).toBeInTheDocument()
  expect(skillsHeader.querySelector('.command-chat-header')).toBeInTheDocument()
  const info = screen.getByRole('heading', { name: 'Repository skills' }).closest('section')
  expect(info).toHaveClass('rounded-lg', 'border', 'bg-background/72', 'shadow-sm')
})

test('user skills appears beneath Overview and opens the global management route', async () => {
  const user = userEvent.setup()
  render(<App />)
  const navigation = await screen.findByRole('complementary', { name: 'Sessions' })
  const overview = within(navigation).getByRole('button', { name: 'Overview' })
  const userSkills = within(navigation).getByRole('button', { name: 'User skills' })
  expect(overview.compareDocumentPosition(userSkills) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  await user.click(userSkills)
  await waitFor(() => expect(window.location.pathname).toBe('/skills'))
  expect(await screen.findByRole('heading', { name: 'User skills' })).toBeInTheDocument()
  expect(screen.getByText('/Users/tester/.agents/skills')).toBeInTheDocument()
  expect(userSkills).toHaveAttribute('aria-current', 'page')
})

test('loading with a session route selects that session', async () => {
  window.history.replaceState({}, '', '/sessions/sess_2')

  render(<App />)

  await waitFor(() => expect(screen.getAllByText('Write docs').length).toBeGreaterThan(0))
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/write-docs'))
  expect(
    screen
      .getAllByRole('button', { name: /Write docs/ })
      .some((button) => button.getAttribute('aria-current') === 'true'),
  ).toBe(true)
})

test('loading with a session slug route selects that session without replacing the slug', async () => {
  window.history.replaceState({}, '', '/sessions/write-docs')
  let resolveSessions: (() => void) | undefined
  const fetch = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path === '/api/health') {
      return jsonResponse({ status: 'ok' })
    }
    if (path === '/api/sessions?limit=50') {
      await new Promise<void>((resolve) => {
        resolveSessions = resolve
      })
      return jsonResponse({ sessions: [firstSession, secondSession] })
    }
    if (path === '/api/sessions/sess_2') {
      return jsonResponse(secondSession)
    }
    if (path === '/api/sessions/sess_2/events?tail=true&turns=50&max_bytes=2097152') {
      return jsonResponse({ events: [] })
    }
    throw new Error(`unexpected URL ${path}`)
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  expect(screen.getByText('Loading session...')).toBeInTheDocument()

  await act(async () => {
    resolveSessions?.()
    await Promise.resolve()
  })

  await waitFor(() => expect(screen.getAllByText('Write docs').length).toBeGreaterThan(0))
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/write-docs'))
  expect(
    screen
      .getAllByRole('button', { name: /Write docs/ })
      .some((button) => button.getAttribute('aria-current') === 'true'),
  ).toBe(true)
})

test('loading with a session slug view route restores the view and preserves slug navigation', async () => {
  const user = userEvent.setup()
  window.history.replaceState({}, '', '/sessions/write-docs/files')

  render(<App />)

  await waitFor(() => expect(screen.getAllByText('Write docs').length).toBeGreaterThan(0))
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/write-docs/files'))
  expect(
    screen
      .getAllByRole('button', { name: 'Show files' })
      .some((button) => button.getAttribute('aria-pressed') === 'true'),
  ).toBe(true)

  await user.click(screen.getAllByRole('button', { name: 'Show console' })[0])

  await waitFor(() => expect(window.location.pathname).toBe('/sessions/write-docs/console'))
})

test('loading with a session file route opens the routed file', async () => {
  vi.stubGlobal('fetch', fetchMock({ fileEntry: true }))
  window.history.replaceState({}, '', '/sessions/inspect-repo/files/main.go')

  render(<App />)

  const fileViewer = await screen.findByRole('region', { name: 'File viewer: main.go' })
  expect(within(fileViewer).getByLabelText('File editor')).toHaveValue('package main\n')
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/inspect-repo/files/main.go'))
})

test('session route shows loading instead of no selection while sessions load', async () => {
  window.history.replaceState({}, '', '/sessions/sess_1')
  let resolveSessions: (() => void) | undefined
  const fetch = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path === '/api/health') {
      return jsonResponse({ status: 'ok' })
    }
    if (path === '/api/sessions?limit=50') {
      await new Promise<void>((resolve) => {
        resolveSessions = resolve
      })
      return jsonResponse({ sessions: [firstSession, secondSession] })
    }
    if (path === '/api/sessions/sess_1/events?tail=true&turns=50&max_bytes=2097152') {
      return jsonResponse({ events: [] })
    }
    throw new Error(`unexpected URL ${path}`)
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  expect(await screen.findByText('Loading session...')).toBeInTheDocument()
  expect(screen.queryByText('No session selected')).not.toBeInTheDocument()

  await act(async () => {
    resolveSessions?.()
    await Promise.resolve()
  })

  await waitFor(() => expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0))
})

test('cold start keeps the root route on Overview while sessions load', async () => {
  window.history.replaceState({}, '', '/')

  render(<App />)

  expect(await screen.findByRole('heading', { name: 'Your work at a glance' })).toBeInTheDocument()
  await waitFor(() => expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0))
  expect(window.location.pathname).toBe('/')
})

test('cached session route renders the session shell while history loads', async () => {
  window.history.replaceState({}, '', '/sessions/sess_1')
  await writeCachedSession(firstSession)
  let resolveSessions: (() => void) | undefined
  let resolveEvents: (() => void) | undefined
  const fetch = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path === '/api/health') {
      return jsonResponse({ status: 'ok' })
    }
    if (path.startsWith('/api/dashboard/runs?')) {
      return jsonResponse({ runs: [], total: 0 })
    }
    if (path.startsWith('/api/dashboard?')) {
      return jsonResponse(emptyDashboardResponse())
    }
    if (path === '/api/sessions?limit=50') {
      await new Promise<void>((resolve) => {
        resolveSessions = resolve
      })
      return jsonResponse({ sessions: [firstSession, secondSession] })
    }
    if (path === '/api/sessions/sess_1') {
      return jsonResponse(firstSession)
    }
    if (path === '/api/sessions/sess_1/events?tail=true&turns=50&max_bytes=2097152') {
      await new Promise<void>((resolve) => {
        resolveEvents = resolve
      })
      return jsonResponse({ events: [] })
    }
    throw new Error(`unexpected URL ${path}`)
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  expect(screen.queryByText('Loading session...')).not.toBeInTheDocument()
  expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0)
  expect(await screen.findByText('Loading chat history...')).toBeInTheDocument()

  await act(async () => {
    resolveEvents?.()
    resolveSessions?.()
    await Promise.resolve()
  })
})

test('cached slug route renders the session shell while sessions load', async () => {
  window.history.replaceState({}, '', '/sessions/write-docs')
  await writeCachedSession(secondSession)
  let resolveSessions: (() => void) | undefined
  const fetch = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path === '/api/health') {
      return jsonResponse({ status: 'ok' })
    }
    if (path === '/api/sessions?limit=50') {
      await new Promise<void>((resolve) => {
        resolveSessions = resolve
      })
      return jsonResponse({ sessions: [firstSession, secondSession] })
    }
    if (path === '/api/sessions/sess_2') {
      return jsonResponse(secondSession)
    }
    if (path === '/api/sessions/sess_2/events?tail=true&turns=50&max_bytes=2097152') {
      return jsonResponse({ events: [] })
    }
    throw new Error(`unexpected URL ${path}`)
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  expect(screen.queryByText('Loading session...')).not.toBeInTheDocument()
  expect(screen.getAllByText('Write docs').length).toBeGreaterThan(0)
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/write-docs'))

  await act(async () => {
    resolveSessions?.()
    await Promise.resolve()
  })
})

test('server session list wins over stale cached slug aliases', async () => {
  window.history.replaceState({}, '', '/sessions/write-docs')
  await writeCachedSession(secondSession)
  const renamedSecondSession: Session = { ...secondSession, title: 'Renamed docs' }
  let resolveSessions: (() => void) | undefined
  const fetch = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path === '/api/health') {
      return jsonResponse({ status: 'ok' })
    }
    if (path === '/api/sessions?limit=50') {
      await new Promise<void>((resolve) => {
        resolveSessions = resolve
      })
      return jsonResponse({ sessions: [firstSession, renamedSecondSession] })
    }
    if (path === '/api/sessions/sess_1') {
      return jsonResponse(firstSession)
    }
    if (path === '/api/sessions/sess_2') {
      return jsonResponse(renamedSecondSession)
    }
    if (path === '/api/sessions/sess_1/events?tail=true&turns=50&max_bytes=2097152') {
      return jsonResponse({ events: [] })
    }
    if (path === '/api/sessions/sess_2/events?tail=true&turns=50&max_bytes=2097152') {
      return jsonResponse({ events: [] })
    }
    throw new Error(`unexpected URL ${path}`)
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  expect(screen.queryByText('Loading session...')).not.toBeInTheDocument()
  expect(screen.getAllByText('Write docs').length).toBeGreaterThan(0)

  await act(async () => {
    resolveSessions?.()
    await Promise.resolve()
  })

  await waitFor(() => expect(window.location.pathname).toBe('/sessions/inspect-repo'))
  expect(
    screen
      .getAllByRole('button', { name: /Inspect repo/ })
      .some((button) => button.getAttribute('aria-current') === 'true'),
  ).toBe(true)
})

test('session route shows inline chat history loading once session details are available', async () => {
  window.history.replaceState({}, '', '/sessions/sess_1')
  let resolveEvents: (() => void) | undefined
  const fetch = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path === '/api/health') {
      return jsonResponse({ status: 'ok' })
    }
    if (path === '/api/sessions?limit=50') {
      return jsonResponse({ sessions: [firstSession, secondSession] })
    }
    if (path === '/api/sessions/sess_1/events?tail=true&turns=50&max_bytes=2097152') {
      await new Promise<void>((resolve) => {
        resolveEvents = resolve
      })
      return jsonResponse({ events: [] })
    }
    throw new Error(`unexpected URL ${path}`)
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  expect(await screen.findByText('Loading chat history...')).toBeInTheDocument()
  expect(screen.queryByText('Loading session...')).not.toBeInTheDocument()

  await act(async () => {
    resolveEvents?.()
    await Promise.resolve()
  })

  await waitFor(() => expect(screen.queryByText('Loading session...')).not.toBeInTheDocument())
})

test('session route restores cached transcript and reconnects without downloading the tail again', async () => {
  window.history.replaceState({}, '', '/sessions/sess_1')
  vi.stubGlobal('indexedDB', createFakeIndexedDB())
  clearSessionEventCacheForTest()
  await writeCachedSession(firstSession)
  await writeCachedSessionEvents(
    'sess_1',
    [
      event(10, 'user.message.completed', { text: 'Cached prompt' }),
      event(11, 'agent.message.completed', { text: 'Cached answer' }),
    ],
    false,
  )
  expect(await readCachedSessionEvents('sess_1')).toMatchObject({ lastSeq: 11 })

  let resolveSessions: (() => void) | undefined
  const fetch = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path === '/api/health') {
      return jsonResponse({ status: 'ok' })
    }
    if (path === '/api/sessions?limit=50') {
      await new Promise<void>((resolve) => {
        resolveSessions = resolve
      })
      return jsonResponse({ sessions: [firstSession, secondSession] })
    }
    if (path === '/api/sessions/sess_1') {
      return jsonResponse(firstSession)
    }
    if (path === '/api/sessions/sess_1/events?tail=true&turns=50&max_bytes=2097152') {
      return jsonResponse({
        events: [
          event(10, 'user.message.completed', { text: 'Cached prompt' }),
          event(11, 'agent.message.completed', { text: 'Cached answer' }),
        ],
      })
    }
    throw new Error(`unexpected URL ${path}`)
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await waitFor(() => expect(screen.getByText('Cached answer')).toBeInTheDocument(), { timeout: 3000 })
  expect(screen.queryByText('Loading session...')).not.toBeInTheDocument()
  expect(
    fetch.mock.calls.some(
      ([url]) => String(url) === '/api/sessions/sess_1/events?tail=true&turns=50&max_bytes=2097152',
    ),
  ).toBe(false)
  await findEventSource('/api/sessions/sess_1/events/stream?after_seq=11')

  await act(async () => {
    resolveSessions?.()
    await Promise.resolve()
  })
})

test('switching sessions discards an unsaved settings rename', async () => {
  const user = userEvent.setup()

  render(<App />)

  await waitFor(() => expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0))
  await user.click(screen.getAllByRole('button', { name: 'Show session settings' })[0])
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/inspect-repo/settings'))

  const input = screen.getByRole('textbox', { name: 'Session name' })
  await user.clear(input)
  await user.type(input, 'Renamed session')
  expect(input).toHaveValue('Renamed session')

  await user.click(screen.getAllByRole('button', { name: /Write docs/ })[0])

  await waitFor(() => expect(window.location.pathname).toBe('/sessions/write-docs/settings'))
  expect(screen.getByRole('textbox', { name: 'Session name' })).toHaveValue('Write docs')
  expect(
    screen
      .getAllByRole('button', { name: /Write docs/ })
      .some((button) => button.getAttribute('aria-current') === 'true'),
  ).toBe(true)
})

test('search button opens global spotlight search', async () => {
  const user = userEvent.setup()
  const fetch = fetchMock()
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await user.click(await screen.findByRole('button', { name: 'Search' }))
  await user.type(screen.getByRole('textbox', { name: 'Search Gorchestra' }), 'Inspect')
  expect(await screen.findByRole('option', { name: /Inspect repo/ })).toBeInTheDocument()
  expect(fetch).toHaveBeenCalledWith('/api/search?q=Inspect&session_id=sess_1', expect.objectContaining({ signal: expect.any(AbortSignal) }))
})

test('global navigation shortcuts open overview, user skills, and recent sessions', async () => {
  const recentSessions = [
    session('sess_3', 'Third newest', '2026-06-12T16:03:00Z'),
    session('sess_1', 'Newest', '2026-06-12T16:05:00Z'),
    session('sess_5', 'Fifth newest', '2026-06-12T16:01:00Z'),
    session('sess_2', 'Second newest', '2026-06-12T16:04:00Z'),
    session('sess_4', 'Fourth newest', '2026-06-12T16:02:00Z'),
  ]
  vi.stubGlobal('fetch', fetchMock({ sessions: recentSessions }))

  render(<App />)
  await screen.findByText('Fifth newest')

  fireEvent.keyDown(window, { key: 'o', metaKey: true })
  await waitFor(() => expect(window.location.pathname).toBe('/'))

  fireEvent.keyDown(window, { key: 's', metaKey: true })
  await waitFor(() => expect(window.location.pathname).toBe('/skills'))

  fireEvent.keyDown(window, { key: '1', metaKey: true })
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/newest'))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveFocus())

  fireEvent.keyDown(window, { key: '5', ctrlKey: true })
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/fifth-newest'))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveFocus())
})

test('initial session load fetches the recent event window and streams after the tail', async () => {
  const fetch = fetchMock({
    events: [event(39, 'agent.message.delta', { text: 'Tail' }), event(40, 'agent.message.completed', { text: 'Tail' })],
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/sess_1/events?tail=true&turns=50&max_bytes=2097152',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    ),
  )
  await waitFor(() =>
    expect(FakeEventSource.instances.some((source) => source.url === '/api/sessions/sess_1/events/stream?after_seq=40'))
      .toBe(true),
  )
})

test('successful prompt submit renders immediately and reconciles with the live stream', async () => {
  const user = userEvent.setup()
  const baseFetch = fetchMock({
    events: [event(40, 'agent.message.completed', { text: 'Previous answer' })],
  })
  let resolveSubmit: ((response: Response) => void) | undefined
  const fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === '/api/sessions/sess_1/messages' && init?.method === 'POST') {
      return new Promise<Response>((resolve) => {
        resolveSubmit = resolve
      })
    }
    return baseFetch(url, init)
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/sess_1/events?tail=true&turns=50&max_bytes=2097152',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    ),
  )
  expect(screen.queryByText('Fresh prompt')).not.toBeInTheDocument()
  const source = await findEventSource('/api/sessions/sess_1/events/stream?after_seq=40')

  await user.type(screen.getByPlaceholderText('Ask the agent to work on this repository...'), 'Fresh prompt{Enter}')

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/sess_1/messages',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Accept: 'application/json' }) }),
    ),
  )
  expect(screen.getAllByText('Fresh prompt')).toHaveLength(1)
  const submitCall = fetch.mock.calls.find(([url]) => String(url) === '/api/sessions/sess_1/messages')
  const submitBody = JSON.parse(String(submitCall?.[1]?.body)) as { client_submission_id: string }
  expect(submitBody.client_submission_id).toBeTruthy()
  expect(fetch.mock.calls.filter(([url]) => String(url) === '/api/sessions/sess_1/events?tail=true&turns=50&max_bytes=2097152')).toHaveLength(1)
  await act(async () => {
    resolveSubmit?.(jsonResponse({ session_id: 'sess_1', status: 'running', accepted_as: 'run' }))
    await Promise.resolve()
  })
  act(() => {
    source.emit(event(41, 'user.message.completed', {
      text: 'Fresh prompt',
      client_submission_id: submitBody.client_submission_id,
    }))
  })
  await waitFor(() => expect(screen.getAllByText('Fresh prompt')).toHaveLength(1))
  expect(FakeEventSource.instances.filter((source) => source.url.includes('/api/sessions/sess_1/events/stream')))
    .toHaveLength(1)
})

test('successful prompt submit keeps the current transcript visible while awaiting its stream event', async () => {
  const user = userEvent.setup()
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
    if (path === '/api/sessions/sess_1/events?tail=true&turns=50&max_bytes=2097152') {
      tailRequests += 1
      return jsonResponse({ events: [event(40, 'user.message.completed', { text: 'Previous prompt' })] })
    }
    throw new Error(`unexpected URL ${path}`)
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await waitFor(() => expect(screen.getByText('Previous prompt')).toBeInTheDocument())
  const source = await findEventSource('/api/sessions/sess_1/events/stream?after_seq=40')

  await user.type(screen.getByPlaceholderText('Ask the agent to work on this repository...'), 'Fresh prompt{Enter}')

  await waitFor(() => expect(fetch).toHaveBeenCalledWith(
    '/api/sessions/sess_1/messages',
    expect.objectContaining({ method: 'POST' }),
  ))
  expect(tailRequests).toBe(1)
  expect(screen.getByText('Previous prompt')).toBeInTheDocument()
  expect(screen.queryByText('Loading chat history...')).not.toBeInTheDocument()
  expect(screen.getAllByText('Fresh prompt')).toHaveLength(1)
  const submitCall = fetch.mock.calls.find(([url]) => String(url) === '/api/sessions/sess_1/messages')
  const submitBody = JSON.parse(String(submitCall?.[1]?.body)) as { client_submission_id: string }

  act(() => {
    source.emit(event(41, 'user.message.completed', {
      text: 'Fresh prompt',
      client_submission_id: submitBody.client_submission_id,
    }))
  })
  await waitFor(() => expect(screen.getAllByText('Fresh prompt')).toHaveLength(1))
})

test('switching back to a cached session restores transcript before replaying stream updates', async () => {
  const user = userEvent.setup()
  const baseFetch = fetchMock()
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    return baseFetch(url, init)
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  const initialSource = await findEventSource('/api/sessions/sess_1/events/stream?after_seq=0')
  act(() => {
    initialSource.emit(event(40, 'user.message.completed', { text: 'Cached prompt' }))
  })
  expect(await screen.findByText('Cached prompt')).toBeInTheDocument()

  await user.click(screen.getAllByRole('button', { name: /Write docs/ })[0])
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/write-docs'))

  await user.click(screen.getAllByRole('button', { name: /Inspect repo/ })[0])

  expect(await screen.findByText('Cached prompt')).toBeInTheDocument()
  expect(screen.queryByText('Loading chat history...')).not.toBeInTheDocument()
  expect(
    fetch.mock.calls.filter(([url]) => String(url) === '/api/sessions/sess_1/events?tail=true&turns=50&max_bytes=2097152'),
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

test('reviewing history buffers live events until jumping without reconnecting the stream', async () => {
  const user = userEvent.setup()
  const baseFetch = fetchMock({
    events: [
      event(39, 'user.message.completed', { text: 'Visible prompt' }),
      event(40, 'agent.message.completed', { item_id: 'msg_1', text: 'Visible answer' }),
    ],
  })
  let tailRequests = 0
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === '/api/sessions/sess_1/events?tail=true&turns=50&max_bytes=2097152') {
      tailRequests += 1
    }
    return baseFetch(url, init)
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  const source = await findEventSource('/api/sessions/sess_1/events/stream?after_seq=40')
  const log = screen.getByRole('log', { name: 'Chat messages' })
  Object.defineProperties(log, {
    scrollTop: { configurable: true, writable: true, value: 120 },
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 400 },
  })
  fireEvent.wheel(log, { deltaY: -100 })
  fireEvent.scroll(log)

  act(() => {
    source.emit(event(41, 'agent.message.completed', { item_id: 'msg_2', text: 'Live answer' }))
  })

  expect(screen.queryByText('Live answer')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Scroll to latest and resume auto-scroll' }))
  expect(await screen.findByText('Live answer')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Scroll to latest and resume auto-scroll' })).not.toBeInTheDocument()
  expect(tailRequests).toBe(2)
  expect(FakeEventSource.instances.filter((candidate) => candidate.url.includes('/api/sessions/sess_1/events/stream')))
    .toHaveLength(1)
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

test('reaching the leading edge fetches the previous turn page', async () => {
  const fetch = fetchMock({
    events: [event(251, 'agent.message.delta', { text: 'Tail' }), event(252, 'agent.message.completed', { text: 'Tail' })],
    olderEvents: [event(249, 'user.message.completed', { text: 'Older prompt' }), event(250, 'agent.message.completed', { text: 'Older answer' })],
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await screen.findByText('Tail')
  const log = screen.getByRole('log', { name: 'Chat messages' })
  fireEvent.wheel(log, { deltaY: -100 })
  fireEvent.scroll(log, { target: { scrollTop: 0 } })

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/sess_1/events?before_seq=252&turns=25&max_bytes=1048576',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    ),
  )
  expect(await screen.findByText('Older prompt')).toBeInTheDocument()
})

test('repeated leading-edge reaches grow the transcript without refetching loaded turns', async () => {
  const baseFetch = fetchMock({
    events: [
      event(9, 'user.message.completed', { text: 'Prompt five' }),
      event(10, 'agent.message.completed', { text: 'Answer five' }),
      event(11, 'user.message.completed', { text: 'Prompt six' }),
      event(12, 'agent.message.completed', { text: 'Answer six' }),
    ],
  })
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url)
    if (path === '/api/sessions/sess_1/events?before_seq=9&turns=25&max_bytes=1048576') {
      return jsonResponse({
        events: [
          event(5, 'user.message.completed', { text: 'Prompt three' }),
          event(6, 'agent.message.completed', { text: 'Answer three' }),
          event(7, 'user.message.completed', { text: 'Prompt four' }),
          event(8, 'agent.message.completed', { text: 'Answer four' }),
        ],
      })
    }
    if (path === '/api/sessions/sess_1/events?before_seq=5&turns=25&max_bytes=1048576') {
      return jsonResponse({
        events: [
          event(1, 'user.message.completed', { text: 'Prompt one' }),
          event(2, 'agent.message.completed', { text: 'Answer one' }),
          event(3, 'user.message.completed', { text: 'Prompt two' }),
          event(4, 'agent.message.completed', { text: 'Answer two' }),
        ],
      })
    }
    return baseFetch(url, init)
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await waitFor(() => expect(screen.getByText('Prompt five')).toBeInTheDocument())
  expect(screen.getByText('Prompt six')).toBeInTheDocument()
  const log = screen.getByRole('log', { name: 'Chat messages' })

  fireEvent.wheel(log, { deltaY: -100 })
  fireEvent.scroll(log, { target: { scrollTop: 0 } })
  await waitFor(() => expect(screen.getByText('Prompt three')).toBeInTheDocument())
  expect(screen.getByText('Prompt four')).toBeInTheDocument()

  fireEvent.wheel(log, { deltaY: -100 })
  fireEvent.scroll(log, { target: { scrollTop: 0 } })
  await waitFor(() => expect(screen.getByText('Prompt one')).toBeInTheDocument())
  expect(screen.getByText('Prompt two')).toBeInTheDocument()
  expect(screen.getByText('Prompt six')).toBeInTheDocument()
  expect(fetch.mock.calls.filter(([url]) => String(url).includes('events?tail=true&turns=50&max_bytes=2097152'))).toHaveLength(1)
  expect(fetch.mock.calls.filter(([url]) => String(url).includes('events?before_seq=')).map(([url]) => String(url))).toEqual([
    '/api/sessions/sess_1/events?before_seq=9&turns=25&max_bytes=1048576',
    '/api/sessions/sess_1/events?before_seq=5&turns=25&max_bytes=1048576',
  ])
})

test('loaded older turns remain visible after submitting a new prompt', async () => {
  const user = userEvent.setup()
  const baseFetch = fetchMock({
    events: [
      event(5, 'user.message.completed', { text: 'Prompt three' }),
      event(6, 'agent.message.completed', { text: 'Answer three' }),
      event(7, 'user.message.completed', { text: 'Prompt four' }),
      event(8, 'agent.message.completed', { text: 'Answer four' }),
    ],
  })
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === '/api/sessions/sess_1/events?before_seq=5&turns=25&max_bytes=1048576') {
      return jsonResponse({
        events: [
          event(1, 'user.message.completed', { text: 'Prompt one' }),
          event(2, 'agent.message.completed', { text: 'Answer one' }),
          event(3, 'user.message.completed', { text: 'Prompt two' }),
          event(4, 'agent.message.completed', { text: 'Answer two' }),
        ],
      })
    }
    return baseFetch(url, init)
  })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await waitFor(() => expect(screen.getByText('Prompt three')).toBeInTheDocument())
  const log = screen.getByRole('log', { name: 'Chat messages' })
  fireEvent.wheel(log, { deltaY: -100 })
  fireEvent.scroll(log, { target: { scrollTop: 0 } })
  await waitFor(() => expect(screen.getByText('Prompt one')).toBeInTheDocument())
  const source = await findEventSource('/api/sessions/sess_1/events/stream?after_seq=8')

  await user.type(screen.getByPlaceholderText('Ask the agent to work on this repository...'), 'Fresh prompt{Enter}')

  expect(fetch.mock.calls.filter(([url]) => String(url) === '/api/sessions/sess_1/events?tail=true&turns=50&max_bytes=2097152')).toHaveLength(1)
  expect(screen.getAllByText('Fresh prompt')).toHaveLength(1)
  const submitCall = fetch.mock.calls.find(([url]) => String(url) === '/api/sessions/sess_1/messages')
  const submitBody = JSON.parse(String(submitCall?.[1]?.body)) as { client_submission_id: string }
  act(() => {
    source.emit(event(9, 'user.message.completed', {
      text: 'Fresh prompt',
      client_submission_id: submitBody.client_submission_id,
    }))
  })
  expect(screen.getAllByText('Fresh prompt')).toHaveLength(1)
  await user.click(screen.getByRole('button', { name: 'Scroll to latest and resume auto-scroll' }))
  await waitFor(() => expect(screen.getAllByText('Fresh prompt')).toHaveLength(1))
  expect(screen.getByText('Prompt one')).toBeInTheDocument()
  expect(screen.getByText('Prompt two')).toBeInTheDocument()
  expect(screen.getByText('Prompt three')).toBeInTheDocument()
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

test('file browser opens the inline files view', async () => {
  const user = userEvent.setup()
  vi.stubGlobal('fetch', fetchMock({ fileEntry: true }))

  render(<App />)

  await user.click(await screen.findByRole('button', { name: /main\.go/i }))

  const fileViewer = await screen.findByRole('region', { name: 'File viewer: main.go' })
  const filesFrame = fileViewer.closest('.host-console-frame')
  const fileSearch = filesFrame?.querySelector<HTMLInputElement>('input[aria-label="Search files and contents"]')
  const fileBrowser = fileSearch?.closest('section')
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/inspect-repo/files/main.go'))
  expect(fileViewer).toBeInTheDocument()
  expect(fileViewer.closest('.mobile-file-viewer-panel')).toBeTruthy()
  expect(within(fileViewer).getAllByText('main.go')).toHaveLength(1)
  expect(within(fileViewer).getByLabelText('File editor')).toHaveValue('package main\n')
  expect(fileBrowser).toHaveClass('hidden')
  expect(fileSearch).toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: 'Show files' }).some((button) => button.getAttribute('aria-pressed') === 'true')).toBe(
    true,
  )

  const closeButton = within(fileViewer).getByRole('button', { name: 'Close file viewer' })
  expect(closeButton).not.toHaveClass('lg:hidden')
  await user.click(closeButton)

  await waitFor(() => expect(screen.queryByRole('region', { name: 'File viewer: main.go' })).not.toBeInTheDocument())
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/inspect-repo/files'))
  expect(filesFrame?.querySelector('input[aria-label="Search files and contents"]')).toBe(fileSearch)
  expect(fileBrowser).not.toHaveClass('hidden')
  expect(screen.getByText('No file selected')).toBeInTheDocument()
})

test('file browser renders markdown files as markdown', async () => {
  const user = userEvent.setup()
  vi.stubGlobal(
    'fetch',
    fetchMock({ fileEntry: true, fileName: 'README.md', fileContent: '# Project Notes\n\n- Ship it' }),
  )

  render(<App />)

  await user.click(await screen.findByRole('button', { name: /README\.md/i }))

  const fileViewer = await screen.findByRole('region', { name: 'File viewer: README.md' })
  expect(fileViewer).toBeInTheDocument()
  expect(within(fileViewer).getAllByText('README.md')).toHaveLength(1)
  expect(within(fileViewer).getByRole('heading', { name: 'Project Notes' })).toBeInTheDocument()
  expect(within(fileViewer).getByRole('listitem')).toHaveTextContent('Ship it')
})

test('file browser edit mode saves workspace files', async () => {
  const user = userEvent.setup()
  vi.stubGlobal('fetch', fetchMock({ fileEntry: true, fileName: 'README.md', fileContent: '# Project Notes\n' }))

  render(<App />)

  await user.click(await screen.findByRole('button', { name: /README\.md/i }))
  const fileViewer = await screen.findByRole('region', { name: 'File viewer: README.md' })
  await user.click(within(fileViewer).getByRole('button', { name: /edit/i }))

  const editor = within(fileViewer).getByLabelText('File editor')
  await user.clear(editor)
  await user.type(editor, '# Edited Notes\n\nSaved')
  await user.click(within(fileViewer).getByRole('button', { name: /^save$/i }))

  await waitFor(() => expect(within(fileViewer).getByText('Saved')).toBeInTheDocument())
  await user.click(within(fileViewer).getByRole('button', { name: /preview/i }))

  expect(within(fileViewer).getByRole('heading', { name: 'Edited Notes' })).toBeInTheDocument()
  expect(within(fileViewer).getAllByText('Saved').length).toBeGreaterThan(0)
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

  const fileViewer = await screen.findByRole('region', { name: 'File viewer: src/main.go' })
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/inspect-repo/files/src%2Fmain.go'))
  expect(within(fileViewer).getByLabelText('File editor')).toHaveValue('package main\n')
  expect(screen.getAllByRole('button', { name: 'Show files' }).some((button) => button.getAttribute('aria-pressed') === 'true')).toBe(
    true,
  )
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

test('archived session uses restore confirmation', async () => {
  const user = userEvent.setup()
  const archivedSession: Session = {
    ...session('sess_3', 'Archived chat', '2026-06-12T16:00:30Z'),
    archived_at: '2026-06-12T16:05:00Z',
  }
  const fetch = fetchMock({ sessions: [firstSession, secondSession, archivedSession] })
  vi.stubGlobal('fetch', fetch)

  render(<App />)

  await user.click(await screen.findByRole('button', { name: 'Search' }))
  await user.type(screen.getByRole('textbox', { name: 'Search Gorchestra' }), 'Archived')
  await user.click(await screen.findByRole('option', { name: /Archived chat/ }))
  await user.click(await screen.findByRole('button', { name: 'Restore selected session' }))

  const dialog = await screen.findByRole('dialog', { name: 'Restore session?' })
  expect(within(dialog).getByText('Archived chat')).toBeInTheDocument()
  expect(fetch).not.toHaveBeenCalledWith(
    '/api/sessions/sess_3/restore',
    expect.objectContaining({ method: 'POST' }),
  )

  await user.click(within(dialog).getByRole('button', { name: 'Restore' }))

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/sess_3/restore',
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
    if (path.startsWith('/api/search?')) {
      const requestURL = new URL(path, 'http://localhost')
      const query = requestURL.searchParams.get('q')?.toLowerCase() ?? ''
      return jsonResponse({
        query,
        results: sessions
          .filter((session) => session.title.toLowerCase().includes(query))
          .map((session) => ({
            id: `session:${session.id}:0`,
            kind: 'session',
            scope: 'global',
            title: session.title,
            session_id: session.id,
            session_title: session.title,
            workspace_path: session.workspace_path,
            archived: Boolean(session.archived_at),
          })),
      })
    }
    const sessionMatch = path.match(/^\/api\/sessions\/([^/?]+)$/)
    if (sessionMatch) {
      const matchedSession = sessions.find((session) => session.id === decodeURIComponent(sessionMatch[1]))
      if (matchedSession) {
        return jsonResponse(matchedSession)
      }
    }
    const attentionClearMatch = path.match(/^\/api\/sessions\/([^/?]+)\/notification-attention\/clear$/)
    if (attentionClearMatch && init?.method === 'POST') {
      const matchedSession = sessions.find((session) => session.id === decodeURIComponent(attentionClearMatch[1]))
      if (matchedSession) {
        return jsonResponse({ ...matchedSession, notification_attention_seq: undefined })
      }
    }
    if (path === '/api/sessions/notification-attention/clear' && init?.method === 'POST') {
      return jsonResponse({ cleared: true })
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
    const restoreMatch = path.match(/^\/api\/sessions\/([^/?]+)\/restore$/)
    if (restoreMatch && init?.method === 'POST') {
      const matchedSession = sessions.find((session) => session.id === decodeURIComponent(restoreMatch[1]))
      if (matchedSession) {
        return jsonResponse({
          ...matchedSession,
          archived_at: null,
          updated_at: '2026-06-12T16:06:00Z',
        })
      }
    }
    if (path === '/api/sessions/sess_1/events?tail=true&turns=50&max_bytes=2097152') {
      return jsonResponse({ events: recentEvents })
    }
    if (path === '/api/sessions/sess_2/events?tail=true&turns=50&max_bytes=2097152') {
      return jsonResponse({ events: [] })
    }
    if (/^\/api\/sessions\/[^/]+\/events\?tail=true&turns=50&max_bytes=2097152$/.test(path)) {
      return jsonResponse({ events: [] })
    }
    const consoleMatch = path.match(/^\/api\/sessions\/([^/?]+)\/console$/)
    if (consoleMatch) {
      const matchedSession = sessions.find((session) => session.id === decodeURIComponent(consoleMatch[1]))
      if (matchedSession) {
        return jsonResponse({ session_id: matchedSession.id, workspace_path: matchedSession.workspace_path, running: false })
      }
    }
    const hostMatch = path.match(/^\/api\/sessions\/([^/?]+)\/host$/)
    if (hostMatch) {
      return jsonResponse({
        session_id: decodeURIComponent(hostMatch[1]),
        config: {
          path: '.gorchestra/host.yaml',
          present: false,
          valid: false,
          stale: false,
          errors: [],
        },
        runtime: { status: 'stopped' },
        services: [],
        log_cursor: 0,
      })
    }
    const hostLogsMatch = path.match(/^\/api\/sessions\/([^/?]+)\/host\/logs$/)
    if (hostLogsMatch) {
      return jsonResponse({ chunks: [], first_seq: 0, last_seq: 0, truncated: false })
    }
    const schedulesMatch = path.match(/^\/api\/sessions\/([^/?]+)\/schedules$/)
    if (schedulesMatch) {
      return jsonResponse({ schedules: [] })
    }
    const repositorySkillsMatch = path.match(/^\/api\/sessions\/([^/?]+)\/repository-skills$/)
    if (repositorySkillsMatch) {
      return jsonResponse({ skills: [] })
    }
    if (path === '/api/user-skills') {
      return jsonResponse({ home_path: '/Users/tester', skills: [] })
    }
    if (path === '/api/sessions/sess_1/events?before_seq=252&turns=25&max_bytes=1048576') {
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

function emptyDashboardResponse() {
  return {
    generated_at: '2026-06-12T16:03:00Z',
    range: '30d',
    range_start: '2026-05-14T00:00:00Z',
    range_end: '2026-06-13T00:00:00Z',
    time_zone: 'UTC',
    bucket: 'day',
    summary: {
      runs: 0,
      completed_runs: 0,
      failed_runs: 0,
      cancelled_runs: 0,
      running_runs: 0,
      unknown_runs: 0,
      active_now: 0,
      success_rate: null,
      agent_runtime_ms: 0,
      tool_calls: 0,
      files_changed: 0,
      input_requests: 0,
      permission_requests: 0,
      workspaces: 0,
      agents: 0,
    },
    activity: [],
    workspaces: [],
    agents: [],
    usage: { tokens: 0, token_runs: 0, cost_runs: 0, eligible_runs: 0, costs: [] },
    outcomes: [
      { kind: 'commit', count: 0, passed: 0, failed: 0, reported: false },
      { kind: 'pull_request', count: 0, passed: 0, failed: 0, reported: false },
      { kind: 'test', count: 0, passed: 0, failed: 0, reported: false },
      { kind: 'delegation', count: 0, passed: 0, failed: 0, reported: false },
    ],
  }
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

  fail() {
    this.onerror?.(new Event('error'))
  }

  close() {}
}

class FakeWebSocket {
  static OPEN = 1
  readyState = FakeWebSocket.OPEN
  private listeners = new Map<string, Set<(event: Event) => void>>()

  constructor() {
    window.setTimeout(() => this.dispatch('open', new Event('open')), 0)
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  send() {}
  close() {}

  private dispatch(type: string, event: Event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

class FakeResizeObserver {
  observe() {}
  disconnect() {}
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
    matches: query === '(hover: hover) and (pointer: fine)',
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
