import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Session } from '@/lib/api'
import { NotificationsPopover } from '@/components/notifications-popover'

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => undefined
  Element.prototype.releasePointerCapture = () => undefined
  Element.prototype.scrollIntoView = () => undefined
})

test('shows unread runs on the bell and opens the selected notification', async () => {
  const user = userEvent.setup()
  const onSelectSession = vi.fn()

  renderNotifications({ onSelectSession })

  await user.click(screen.getByRole('button', { name: 'Notifications, 2 unread' }))

  expect(screen.getByText('2 unread runs')).toBeInTheDocument()
  expect(screen.getByText('First finished run')).toBeInTheDocument()
  expect(screen.getByText('Second finished run')).toBeInTheDocument()

  await user.click(screen.getByRole('menuitem', { name: 'Open notification for Second finished run' }))
  expect(onSelectSession).toHaveBeenCalledWith('sess-2')
})

test('dismisses all notifications from the popover', async () => {
  const user = userEvent.setup()
  const onDismissAll = vi.fn()

  renderNotifications({ onDismissAll })

  await user.click(screen.getByRole('button', { name: 'Notifications, 2 unread' }))
  await user.click(screen.getByRole('menuitem', { name: 'Dismiss all notifications' }))

  expect(onDismissAll).toHaveBeenCalledOnce()
})

test('keeps browser and sound settings with the notification list', async () => {
  const user = userEvent.setup()
  const onEnable = vi.fn()
  const onSoundEnabledChange = vi.fn()

  renderNotifications({ onEnable, onSoundEnabledChange })

  await user.click(screen.getByRole('button', { name: 'Notifications, 2 unread' }))
  await user.click(screen.getByRole('menuitemcheckbox', { name: /Browser alerts/ }))
  await user.click(screen.getByRole('menuitemcheckbox', { name: /Sound/ }))

  expect(onEnable).toHaveBeenCalledOnce()
  expect(onSoundEnabledChange).toHaveBeenCalledWith(false)
})

function renderNotifications(overrides: Partial<Parameters<typeof NotificationsPopover>[0]> = {}) {
  return render(
    <NotificationsPopover
      notifications={notifications}
      supported
      status="default"
      error=""
      soundEnabled
      dismissing={false}
      onSelectSession={() => undefined}
      onDismissAll={() => undefined}
      onEnable={() => undefined}
      onDisable={() => undefined}
      onSoundEnabledChange={() => undefined}
      {...overrides}
    />,
  )
}

const notifications: Session[] = [
  session('sess-1', 'First finished run', '2026-09-03T15:00:00Z'),
  session('sess-2', 'Second finished run', '2026-09-03T14:00:00Z'),
]

function session(id: string, title: string, updatedAt: string): Session {
  return {
    id,
    title,
    agent_type: 'codex',
    status: 'idle',
    workspace_path: '/repo',
    event_count: 4,
    last_event_seq: 4,
    tool_count: 1,
    created_at: updatedAt,
    updated_at: updatedAt,
    completed_at: updatedAt,
    archived_at: null,
  }
}
