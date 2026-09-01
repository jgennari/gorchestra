import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Session } from '@/lib/api'
import { SessionSettings } from '@/components/session-settings'

const baseSession: Session = {
  id: 'sess_1',
  title: 'Inspect repo',
  agent_type: 'codex',
  status: 'idle',
  workspace_path: '/repo',
  agent_options: { codex: { permission_policy: 'deny' } },
  event_count: 0,
  tool_count: 0,
  created_at: '2026-06-12T16:00:00Z',
  updated_at: '2026-06-12T16:00:00Z',
  completed_at: null,
  archived_at: null,
}

test('renders a full-width header with the settings in a separate card', () => {
  renderSettings()

  const headerCard = screen.getByRole('heading', { name: 'Session settings' }).closest('section')
  const settingsCard = screen.getByRole('region', { name: 'Session configuration' })
  expect(headerCard).toHaveClass('border', 'border-border/80', 'bg-background/72', 'shadow-sm')
  expect(within(headerCard as HTMLElement).queryByRole('textbox', { name: 'Session name' })).not.toBeInTheDocument()
  expect(settingsCard).toHaveClass('border', 'border-border/80', 'bg-background/72', 'shadow-sm')
  expect(within(settingsCard).getByRole('textbox', { name: 'Session name' })).toHaveValue('Inspect repo')
  expect(within(settingsCard).getByText('sess_1')).toBeInTheDocument()
  expect(within(settingsCard).getByText('/repo')).toBeInTheDocument()
  expect(within(settingsCard).getByRole('radiogroup', { name: 'Permission policy' })).toBeInTheDocument()
  expect(within(settingsCard).getByRole('switch', { name: 'Debug events' })).toBeInTheDocument()
  expect(settingsCard.parentElement).toHaveClass('w-full', 'flex-1')
  expect(settingsCard.parentElement).not.toHaveClass('max-w-5xl')
})

test('updates the session name, permission policy, debug setting, and copies identifiers', async () => {
  const user = userEvent.setup()
  const onUpdateTitle = vi.fn(async () => undefined)
  const onUpdateAgentOptions = vi.fn(async () => undefined)
  const onShowDebugEventsChange = vi.fn()
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

  renderSettings({ onUpdateTitle, onUpdateAgentOptions, onShowDebugEventsChange })

  const name = screen.getByRole('textbox', { name: 'Session name' })
  await user.clear(name)
  await user.type(name, 'Renamed session')
  await user.click(screen.getByRole('button', { name: 'Save session name' }))
  await user.click(screen.getByRole('radio', { name: 'Ask' }))
  await user.click(screen.getByRole('switch', { name: 'Debug events' }))
  await user.click(screen.getByRole('button', { name: 'Copy session key' }))
  await user.click(screen.getByRole('button', { name: 'Copy workspace path' }))

  expect(onUpdateTitle).toHaveBeenCalledWith('Renamed session')
  expect(onUpdateAgentOptions).toHaveBeenCalledWith({ codex: { permission_policy: 'ask' } })
  expect(onShowDebugEventsChange).toHaveBeenCalledWith(true)
  expect(writeText).toHaveBeenCalledWith('sess_1')
  expect(writeText).toHaveBeenCalledWith('/repo')
})

test('shows loading state while a routed session resolves', () => {
  renderSettings({ session: null, resolvingSessionID: 'sess_1' })

  expect(screen.getByText('Loading settings…')).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Session settings' })).not.toBeInTheDocument()
})

type Props = Parameters<typeof SessionSettings>[0]

function renderSettings(overrides: Partial<Props> = {}) {
  return render(
    <SessionSettings
      session={baseSession}
      showDebugEvents={false}
      onUpdateTitle={async () => undefined}
      onUpdateWorkspace={async () => undefined}
      onUpdateAgentOptions={async () => undefined}
      onShowDebugEventsChange={() => undefined}
      {...overrides}
    />,
  )
}
