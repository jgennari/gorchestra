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

test('session list shows navigation shortcuts and numbers the first five sessions', () => {
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
  expect(sessionRows[0].querySelector('kbd')?.closest('.session-row-meta')).toBeNull()
  expect(sessionRows[4].querySelector('kbd')).toHaveTextContent(`${modifier}5`)
  expect(sessionRows[5].querySelector('kbd')).toBeNull()
})

test('session rows are keyboard selectable', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()

  render(<SessionListHarness onSelect={onSelect} />)

  screen.getByRole('button', { name: /running work/i }).focus()
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
