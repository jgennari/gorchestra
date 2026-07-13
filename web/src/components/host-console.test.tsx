import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HostConsole } from '@/components/host-console'
import type { Session } from '@/lib/api'

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

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    consoleWebSocketURL: () => 'ws://localhost/api/sessions/sess_1/console/ws',
    getConsoleStatus: vi.fn(async () => ({ running: true, workspace_path: '/repo' })),
    killConsole: vi.fn(async () => undefined),
  }
})

class FakeWebSocket {
  static OPEN = 1
  readyState = FakeWebSocket.OPEN
  private listeners = new Map<string, Set<(event: Event) => void>>()

  constructor() {
    setTimeout(() => this.dispatch('open', new Event('open')), 0)
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

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('mobile console body reserves room for the floating header', () => {
  render(
    <HostConsole
      session={baseSession}
      resolvedTheme="dark"
      mobileLeadingAction={<button type="button">Open sessions</button>}
      onUpdateTitle={async () => undefined}
      onUpdateWorkspace={async () => undefined}
    />,
  )

  expect(screen.getByRole('button', { name: 'Open sessions' }).closest('.mobile-floating-header-shell')).toBeTruthy()
  expect(screen.getByTestId('host-console-frame')).toHaveClass('host-console-frame')
})

test('console shows loading while a routed session resolves', () => {
  render(
    <HostConsole
      session={null}
      resolvingSessionID="sess_1"
      resolvedTheme="dark"
      onUpdateTitle={async () => undefined}
      onUpdateWorkspace={async () => undefined}
    />,
  )

  expect(screen.getByText('Loading session...')).toBeInTheDocument()
  expect(screen.queryByText('Select a session to open a console.')).not.toBeInTheDocument()
})

test('mobile console actions include session actions', async () => {
  const user = userEvent.setup()
  const onClear = vi.fn(async () => undefined)
  const onCompact = vi.fn(async () => undefined)
  const onToggleArchive = vi.fn(async () => undefined)
  const onOpenWorkspaceDetails = vi.fn()

  render(
    <HostConsole
      session={{ ...baseSession, agent_type: 'codex', provider_session_id: 'thread_1' }}
      resolvedTheme="dark"
      mobileLeadingAction={<button type="button">Open sessions</button>}
      onUpdateTitle={async () => undefined}
      onUpdateWorkspace={async () => undefined}
      onClear={onClear}
      onCompact={onCompact}
      onToggleArchive={onToggleArchive}
      onOpenWorkspaceDetails={onOpenWorkspaceDetails}
    />,
  )

  const mobileHeader = screen.getByRole('button', { name: 'Open sessions' }).closest('.mobile-floating-header-shell')
  expect(mobileHeader).not.toBeNull()

  await user.click(within(mobileHeader as HTMLElement).getByRole('button', { name: 'Console actions' }))
  await user.click(within(mobileHeader as HTMLElement).getByRole('button', { name: 'Workspace details' }))

  await user.click(within(mobileHeader as HTMLElement).getByRole('button', { name: 'Console actions' }))
  await user.click(within(mobileHeader as HTMLElement).getByRole('button', { name: 'Clear context' }))

  await user.click(within(mobileHeader as HTMLElement).getByRole('button', { name: 'Console actions' }))
  await user.click(within(mobileHeader as HTMLElement).getByRole('button', { name: 'Compact context' }))

  await user.click(within(mobileHeader as HTMLElement).getByRole('button', { name: 'Console actions' }))
  await user.click(within(mobileHeader as HTMLElement).getByRole('button', { name: 'Archive session' }))

  expect(onOpenWorkspaceDetails).toHaveBeenCalledOnce()
  expect(onClear).toHaveBeenCalledOnce()
  expect(onCompact).toHaveBeenCalledOnce()
  expect(onToggleArchive).toHaveBeenCalledOnce()
})
