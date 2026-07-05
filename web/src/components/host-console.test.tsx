import { render, screen } from '@testing-library/react'
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
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor() {
    setTimeout(() => this.onopen?.(), 0)
  }

  send() {}
  close() {}
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
    />,
  )

  expect(screen.getByRole('button', { name: 'Open sessions' }).closest('.mobile-floating-header-shell')).toBeTruthy()
  expect(screen.getByTestId('host-console-frame')).toHaveClass('host-console-frame')
})
