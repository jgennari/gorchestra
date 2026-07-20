import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HostPreview } from '@/components/host-preview'
import {
  checkHost,
  getHostStatus,
  listHostLogs,
  restartHost,
  startHost,
  stopHost,
  validateHost,
  type HostStatus,
  type Session,
} from '@/lib/api'

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getHostStatus: vi.fn(),
    listHostLogs: vi.fn(),
    validateHost: vi.fn(),
    startHost: vi.fn(),
    stopHost: vi.fn(),
    restartHost: vi.fn(),
    checkHost: vi.fn(),
    hostLogStreamURL: vi.fn((sessionID: string, afterSeq: number) => `/host/${sessionID}/logs?after_seq=${afterSeq}`),
  }
})

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  private listeners = new Map<string, Set<(event: Event) => void>>()

  constructor(url: string | URL) {
    this.url = String(url)
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (typeof listener !== 'function') return
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  close() {}

  dispatch(type: string, data = '') {
    const event = type === 'open' ? new Event(type) : new MessageEvent(type, { data })
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const baseSession: Session = {
  id: 'sess_1',
  title: 'Hosted app',
  agent_type: 'codex',
  status: 'idle',
  workspace_path: '/repo',
  event_count: 0,
  tool_count: 0,
  created_at: '2026-07-17T12:00:00Z',
  updated_at: '2026-07-17T12:00:00Z',
  completed_at: null,
  archived_at: null,
}

const stoppedStatus: HostStatus = {
  session_id: 'sess_1',
  config: {
    path: '.gorchestra/host.yaml',
    present: true,
    valid: true,
    stale: false,
    name: 'demo',
    digest: 'new',
    errors: [],
  },
  runtime: { status: 'stopped' },
  services: [
    { name: 'web', status: 'stopped', port: 15173, route_paths: ['/'] },
    { name: 'api', status: 'stopped', port: 18080, route_paths: ['/api'] },
  ],
  log_cursor: 0,
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.mocked(getHostStatus).mockResolvedValue(stoppedStatus)
  vi.mocked(listHostLogs).mockResolvedValue({ chunks: [], first_seq: 0, last_seq: 0, truncated: false })
  vi.mocked(validateHost).mockResolvedValue(stoppedStatus)
  vi.mocked(startHost).mockResolvedValue({ ...stoppedStatus, runtime: { status: 'starting' } })
  vi.mocked(stopHost).mockResolvedValue(stoppedStatus)
  vi.mocked(restartHost).mockResolvedValue({ ...stoppedStatus, runtime: { status: 'starting' } })
  vi.mocked(checkHost).mockResolvedValue(stoppedStatus)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

test('shows a missing recipe and keeps start disabled', async () => {
  vi.mocked(getHostStatus).mockResolvedValue({
    ...stoppedStatus,
    config: { path: '.gorchestra/host.yaml', present: false, valid: false, stale: false, errors: [] },
    services: [],
  })

  render(<HostPreview session={baseSession} />)

  expect(await screen.findByText('No host recipe found')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled()
  expect(screen.getByText('.gorchestra/host.yaml')).toBeInTheDocument()
})

test('shows invalid recipe errors and stale running recipes', async () => {
  const { rerender } = render(<HostPreview session={baseSession} />)
  vi.mocked(getHostStatus).mockResolvedValueOnce({
    ...stoppedStatus,
    config: { ...stoppedStatus.config, valid: false, errors: ['services[0].command is required'] },
  })

  rerender(<HostPreview session={{ ...baseSession, id: 'sess_invalid' }} />)
  expect(await screen.findByText('Host recipe is invalid')).toBeInTheDocument()
  expect(screen.getByText('services[0].command is required')).toBeInTheDocument()

  vi.mocked(getHostStatus).mockResolvedValueOnce({
    ...stoppedStatus,
    session_id: 'sess_stale',
    config: { ...stoppedStatus.config, stale: true, loaded_digest: 'old' },
    runtime: { status: 'running', url: 'http://demo.localhost:8080' },
  })
  rerender(<HostPreview session={{ ...baseSession, id: 'sess_stale' }} />)
  expect(await screen.findByText('Recipe changed while this preview was running')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Restart' })).toBeEnabled()
})

test('renders services and retained output, then accepts live SSE chunks', async () => {
  const runningStatus: HostStatus = {
    ...stoppedStatus,
    runtime: { status: 'running', url: 'http://demo.localhost:8080', started_at: '2026-07-17T12:01:00Z' },
    services: [
      { name: 'web', status: 'running', port: 15173, route_paths: ['/'] },
      { name: 'api', status: 'running', port: 18080, route_paths: ['/api'] },
    ],
    log_cursor: 2,
  }
  vi.mocked(getHostStatus).mockResolvedValue(runningStatus)
  vi.mocked(checkHost).mockResolvedValue(runningStatus)
  vi.mocked(listHostLogs).mockResolvedValue({
    chunks: [
      { seq: 1, service: 'web', stream: 'stdout', data: 'Vite ready', created_at: '2026-07-17T12:01:01Z' },
      { seq: 2, service: 'api', stream: 'stderr', data: 'warming cache', created_at: '2026-07-17T12:01:02Z' },
    ],
    first_seq: 1,
    last_seq: 2,
    truncated: true,
  })

  const user = userEvent.setup()
  render(<HostPreview session={baseSession} />)

  const openLink = await screen.findByRole('link', { name: 'Open preview' })
  expect(openLink).toHaveAttribute('href', 'http://demo.localhost:8080')
  expect(screen.getByText('127.0.0.1:15173')).toBeInTheDocument()
  expect(screen.getByText('Vite ready')).toBeInTheDocument()
  expect(screen.getByText('Older output has rolled out of the retained log buffer.')).toBeInTheDocument()

  const logViewport = screen.getByTestId('host-log-viewport')
  expect(logViewport).toHaveClass('min-h-0', 'flex-1', 'bg-background/72')
  expect(logViewport).not.toHaveClass('h-80', 'bg-slate-950')
  for (const heading of ['Hosted preview', 'Runtime', 'Services', 'Service logs']) {
    expect(screen.getByRole('heading', { name: heading }).closest('section')).toHaveClass('bg-background/72')
  }

  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
  FakeEventSource.instances[0].dispatch('open')
  FakeEventSource.instances[0].dispatch('log', JSON.stringify({
    seq: 3,
    service: 'web',
    stream: 'stdout',
    data: 'hmr connected',
    created_at: '2026-07-17T12:01:03Z',
  }))
  expect(await screen.findByText('hmr connected')).toBeInTheDocument()
  expect(screen.getByText('live')).toBeInTheDocument()

  await user.selectOptions(screen.getByLabelText('Filter logs by service'), 'api')
  expect(screen.queryByText('Vite ready')).not.toBeInTheDocument()
  expect(screen.getByText('warming cache')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Check' }))
  expect(checkHost).toHaveBeenCalledWith('sess_1')
})

test('starts a valid stopped preview and disables start for archived sessions', async () => {
  const user = userEvent.setup()
  const { rerender } = render(<HostPreview session={baseSession} />)

  await user.click(await screen.findByRole('button', { name: 'Start' }))
  expect(startHost).toHaveBeenCalledWith('sess_1')

  rerender(<HostPreview session={{ ...baseSession, id: 'sess_archived', archived_at: '2026-07-17T12:10:00Z' }} />)
  expect(await screen.findByText('Restore this session before starting its preview.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled()
})
