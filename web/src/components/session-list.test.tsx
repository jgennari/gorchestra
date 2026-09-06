import type { ComponentProps } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Session } from '@/lib/api'
import { SessionList } from '@/components/session-list'

const sessions: Session[] = [
  {
    id: 'sess_running',
    title: 'Running work',
    agent_type: 'fake',
    status: 'running',
    workspace_path: '/repo',
    event_count: 0,
    tool_count: 0,
    created_at: '2026-06-12T16:00:00Z',
    updated_at: '2026-06-12T16:10:00Z',
    completed_at: null,
    archived_at: null,
  },
  {
    id: 'sess_failed',
    title: 'Documentation pass',
    agent_type: 'codex',
    status: 'failed',
    workspace_path: '/repo',
    event_count: 0,
    tool_count: 0,
    created_at: '2026-06-12T16:00:00Z',
    updated_at: '2026-06-12T16:05:00Z',
    completed_at: '2026-06-12T16:05:00Z',
    archived_at: null,
  },
  {
    id: 'sess_archived',
    title: 'Archived notes',
    agent_type: 'claude',
    status: 'idle',
    workspace_path: '/repo',
    event_count: 2,
    tool_count: 0,
    created_at: '2026-06-12T16:00:00Z',
    updated_at: '2026-06-12T16:03:00Z',
    completed_at: '2026-06-12T16:03:00Z',
    archived_at: '2026-06-12T16:06:00Z',
  },
]

test('session list exposes spotlight search without the old filter controls', async () => {
  const user = userEvent.setup()
  const onSearch = vi.fn()

  render(<SessionListHarness onSearch={onSearch} />)

  expect(screen.queryByRole('textbox', { name: 'Search sessions' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Session filters' })).not.toBeInTheDocument()
  expect(screen.getByText('Running work')).toBeInTheDocument()
  expect(screen.getByText('Documentation pass')).toBeInTheDocument()
  expect(screen.queryByText('Archived notes')).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Search' }))
  expect(onSearch).toHaveBeenCalledOnce()
})

test('session list shows hover-only shortcuts for the first five sessions', () => {
  const extraSessions = [
    sessionFixture('sess_3', 'Third'),
    sessionFixture('sess_4', 'Fourth'),
    sessionFixture('sess_5', 'Fifth'),
    sessionFixture('sess_6', 'Sixth'),
  ]
  const { container } = render(<SessionListHarness sessions={[...sessions.slice(0, 2), ...extraSessions]} />)
  const modifier = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl '
  const shortcuts = Array.from(container.querySelectorAll('kbd'), (element) => element.textContent)

  expect(shortcuts).toEqual([
    `${modifier}O`,
    `${modifier}S`,
    `${modifier}K`,
    `${modifier}1`,
    `${modifier}2`,
    `${modifier}3`,
    `${modifier}4`,
    `${modifier}5`,
  ])
  const sessionRows = container.querySelectorAll('.session-row')
  expect(sessionRows[0].querySelector('kbd')?.parentElement).toHaveClass(
    'hidden',
    'overflow-hidden',
    'opacity-0',
    'md:inline-flex',
    'md:w-0',
    'md:group-hover:w-9',
    'md:group-hover:opacity-100',
  )
  expect(sessionRows[4].querySelector('kbd')).toHaveTextContent(`${modifier}5`)
  expect(sessionRows[5].querySelector('kbd')).toBeNull()
})

test('session rows are keyboard selectable', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()

  render(<SessionListHarness onSelect={onSelect} />)

  screen.getByRole('button', { name: 'Running work' }).focus()
  await user.keyboard('{Enter}')

  expect(onSelect).toHaveBeenCalledWith('sess_running')
})

test('session rows show status as a dot indicator', () => {
  render(<SessionListHarness />)

  expect(screen.getByRole('img', { name: 'Session status: running' })).toHaveClass(
    'animate-pulse',
    'bg-[hsl(var(--success))]',
  )
  expect(screen.queryByText('running')).not.toBeInTheDocument()
})

test('session rows omit agent and update time metadata', () => {
  const { container } = render(<SessionListHarness sessions={[sessions[0]]} />)

  expect(screen.queryByText(/fake/)).not.toBeInTheDocument()
  expect(container.querySelector('.session-row-meta')).not.toBeInTheDocument()
})

test('selected session row still shows the session status indicator', () => {
  render(<SessionListHarness selectedSessionID="sess_running" />)

  expect(screen.getByRole('img', { name: 'Session status: running' })).toHaveClass(
    'animate-pulse',
    'bg-[hsl(var(--success))]',
  )
})

test('session row keeps a red dot for a transient chat error when it is not selected', () => {
  render(
    <SessionListHarness
      selectedSessionID="sess_failed"
      errorSessionIDs={new Set(['sess_running'])}
    />,
  )

  const status = screen.getByRole('img', { name: 'Session has an error' })
  expect(status).toHaveClass('bg-destructive')
  expect(status).not.toHaveClass('animate-pulse', 'bg-[hsl(var(--success))]')
})

test('session rows show pending input with a pulsing yellow indicator', () => {
  render(<SessionListHarness sessions={[{ ...sessions[0], pending_input: true }]} />)

  expect(screen.getByRole('img', { name: 'Session pending user input' })).toHaveClass(
    'animate-pulse',
    'bg-[hsl(var(--warning))]',
  )
})

test('idle session rows show unseen results with a solid yellow indicator', () => {
  render(
    <SessionListHarness
      sessions={[{ ...sessions[0], status: 'idle', event_count: 8, last_event_seq: 8 }]}
      lastSeenSeqBySession={{ sess_running: 4 }}
    />,
  )

  expect(screen.getByRole('img', { name: 'Session has unseen results' })).toHaveClass('bg-[hsl(var(--warning))]')
  expect(screen.getByRole('img', { name: 'Session has unseen results' })).not.toHaveClass('animate-pulse')
})

test('session list keeps notifications in the header instead of adding a navigation row', async () => {
  const user = userEvent.setup()
  const onOpen = vi.fn()

  render(<SessionListHarness notificationAction={<button onClick={onOpen}>Notifications</button>} />)

  expect(screen.queryByRole('button', { name: 'Dismiss all notifications' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Notifications' }))
  expect(onOpen).toHaveBeenCalledOnce()
})

test('session list exposes the app menu action', async () => {
  const user = userEvent.setup()
  const onOpen = vi.fn()

  render(<SessionListHarness appMenuAction={<button onClick={onOpen}>App menu</button>} />)

  await user.click(screen.getByRole('button', { name: 'App menu' }))

  expect(onOpen).toHaveBeenCalledOnce()
})

test('full session list uses the app icon instead of the text header', () => {
  render(<SessionListHarness />)

  expect(screen.getByRole('img', { name: 'Gorchestra' })).toHaveAttribute('src', '/icon.svg')
  expect(screen.queryByText('Gorchestra')).not.toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Sessions' })).not.toBeInTheDocument()
})

test('embedded session list hides desktop header controls', () => {
  render(<SessionListHarness variant="embedded" />)

  expect(screen.queryByRole('heading', { name: 'Sessions' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Theme: System' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Create session' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument()
})

test('pinned sessions use only a persistent highlighted pin treatment', () => {
  const pinned = { ...sessions[1], pinned_at: '2026-06-12T16:20:00Z' }
  const { container } = render(
    <SessionListHarness sessions={[pinned, sessions[0]]} onPinChange={() => undefined} />,
  )

  expect(container.querySelectorAll('.session-row')[0]).toHaveAttribute('data-session-id', pinned.id)
  expect(container.querySelector(`[data-session-id="${pinned.id}"]`)).toHaveAttribute('data-pinned', 'true')
  expect(screen.getByRole('button', { name: 'Unpin session' })).toHaveClass('text-primary', 'opacity-100')
  expect(screen.getByRole('button', { name: 'Unpin session' })).toHaveClass('justify-center')
  expect(screen.queryByText('Pinned')).not.toBeInTheDocument()
  expect(screen.queryByText('Recent')).not.toBeInTheDocument()
})

test('right-side pin action pins and unpins without selecting the session', async () => {
  const user = userEvent.setup()
  const onPinChange = vi.fn()
  const onSelect = vi.fn()
  const pinned = { ...sessions[1], pinned_at: '2026-06-12T16:20:00Z' }

  const { rerender } = render(
    <SessionListHarness sessions={[sessions[0]]} onPinChange={onPinChange} onSelect={onSelect} />,
  )
  await user.click(screen.getByRole('button', { name: 'Pin session' }))
  expect(onPinChange).toHaveBeenCalledWith('sess_running', true)
  expect(onSelect).not.toHaveBeenCalled()

  rerender(<SessionListHarness sessions={[pinned]} onPinChange={onPinChange} onSelect={onSelect} />)
  await user.click(screen.getByRole('button', { name: 'Unpin session' }))
  expect(onPinChange).toHaveBeenCalledWith('sess_failed', false)
})

test('unpinned session action stays visible on mobile and becomes hover-only on desktop', () => {
  render(<SessionListHarness sessions={[sessions[0]]} onPinChange={() => undefined} />)

  expect(screen.getByRole('button', { name: 'Pin session' })).toHaveClass(
    'size-8',
    'justify-center',
    'opacity-100',
    'md:pointer-events-none',
    'md:opacity-0',
    'md:group-hover:pointer-events-auto',
    'md:group-hover:opacity-100',
  )
})

test('session shortcuts consume row width only while hovered or focused', () => {
  const { container } = render(
    <SessionListHarness sessions={[sessions[0]]} onPinChange={() => undefined} />,
  )

  expect(screen.getByText(/O$/, { selector: 'kbd' })).toHaveClass('inline-flex', 'w-9', 'justify-center')
  expect(container.querySelector('.session-row kbd')).toHaveClass('inline-flex', 'w-9', 'justify-center')
  expect(container.querySelector('.session-row kbd')?.parentElement).toHaveClass(
    'md:w-0',
    'md:group-hover:w-9',
    'md:group-focus-within:w-9',
  )
  expect(screen.getByRole('button', { name: 'Pin session' })).toHaveClass('size-8', 'justify-center')
})

test('navigation shortcuts slide in only while their row is hovered or focused', () => {
  render(<SessionListHarness />)

  const shortcutSlot = screen.getByText(/O$/, { selector: 'kbd' }).parentElement
  expect(shortcutSlot).toHaveClass(
    'hidden',
    'overflow-hidden',
    'opacity-0',
    'md:inline-flex',
    'md:w-0',
    'md:group-hover:w-9',
    'md:group-focus-within:w-9',
  )
})

test('session list has no drag handle or drop target', () => {
  render(<SessionListHarness onPinChange={() => undefined} />)

  expect(screen.queryByRole('button', { name: 'Drag to pin' })).not.toBeInTheDocument()
  expect(screen.queryByTestId('session-pin-drop-target')).not.toBeInTheDocument()
})

function baseProps() {
  return {
    sessions: sessions.filter((session) => !session.archived_at),
    selectedSessionID: null,
    lastSeenSeqBySession: {},
    onSelect: () => undefined,
    onSearch: () => undefined,
    onCreate: () => undefined,
  }
}

function SessionListHarness(props: Partial<ComponentProps<typeof SessionList>>) {
  return <SessionList {...baseProps()} {...props} />
}

function sessionFixture(id: string, title: string): Session {
  return {
    ...sessions[0],
    id,
    title,
  }
}
