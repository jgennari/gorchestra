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
    created_at: '2026-06-12T16:00:00Z',
    updated_at: '2026-06-12T16:05:00Z',
    completed_at: '2026-06-12T16:05:00Z',
    archived_at: null,
  },
]

test('session list filters sessions with client side search', async () => {
  const user = userEvent.setup()

  render(<SessionList {...baseProps()} />)

  expect(screen.queryByRole('tab', { name: 'All' })).not.toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: 'Running' })).not.toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: 'Failed' })).not.toBeInTheDocument()
  expect(screen.getByText('Running work')).toBeInTheDocument()
  expect(screen.getByText('Documentation pass')).toBeInTheDocument()

  await user.type(screen.getByRole('textbox', { name: 'Search sessions' }), 'failed')

  expect(screen.queryByText('Running work')).not.toBeInTheDocument()
  expect(screen.getByText('Documentation pass')).toBeInTheDocument()
})

test('session rows are keyboard selectable', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()

  render(
    <SessionList
      {...baseProps()}
      onSelect={onSelect}
    />,
  )

  screen.getByRole('button', { name: /running work/i }).focus()
  await user.keyboard('{Enter}')

  expect(onSelect).toHaveBeenCalledWith('sess_running')
})

test('session rows show status as a dot indicator', () => {
  render(
    <SessionList {...baseProps()} />,
  )

  expect(screen.getByRole('img', { name: 'Session status: running' })).toHaveClass(
    'animate-pulse',
    'bg-[hsl(var(--success))]',
  )
  expect(screen.queryByText('running')).not.toBeInTheDocument()
})

test('selected connected session row shows a backend connection dot', () => {
  render(
    <SessionList
      {...baseProps()}
      selectedSessionID="sess_running"
      connectedSessionID="sess_running"
    />,
  )

  expect(screen.getByRole('img', { name: 'Session connected to backend' })).toHaveClass(
    'animate-pulse',
    'bg-[hsl(var(--success))]',
  )
})

test('session list exposes the global theme toggle', async () => {
  const user = userEvent.setup()
  const onThemeToggle = vi.fn()

  render(<SessionList {...baseProps()} onThemeToggle={onThemeToggle} />)

  await user.click(screen.getByRole('button', { name: 'Theme: System' }))

  expect(onThemeToggle).toHaveBeenCalledOnce()
})

function baseProps() {
  return {
    sessions,
    selectedSessionID: null,
    onSelect: () => undefined,
    onCreate: () => undefined,
    themePreference: 'system' as const,
    resolvedTheme: 'light' as const,
    onThemeToggle: () => undefined,
  }
}
