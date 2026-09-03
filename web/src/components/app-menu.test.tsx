import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppMenu } from '@/components/app-menu'

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => undefined
  Element.prototype.releasePointerCapture = () => undefined
  Element.prototype.scrollIntoView = () => undefined
})

test('groups theme and version controls in the app menu', async () => {
  const user = userEvent.setup()
  const onThemeChange = vi.fn()

  render(
    <AppMenu
      themePreference="system"
      onThemeChange={onThemeChange}
      release={{
        currentVersion: '0.2.8',
        latestVersion: '0.3.0',
        updateAvailable: true,
        releaseURL: 'https://github.com/jgennari/gorchestra/releases/tag/v0.3.0',
        checkedAt: '2026-07-30T16:00:00Z',
        checking: false,
      }}
    />,
  )

  await user.click(screen.getByRole('button', { name: 'App menu, update available' }))

  expect(screen.getByText('Version 0.2.8')).toBeInTheDocument()
  expect(screen.getByText('v0.3.0 available')).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: /View update/ })).toHaveAttribute(
    'href',
    'https://github.com/jgennari/gorchestra/releases/tag/v0.3.0',
  )
  expect(screen.queryByText('Notifications')).not.toBeInTheDocument()

  await user.click(screen.getByRole('menuitemradio', { name: 'Dark' }))
  expect(onThemeChange).toHaveBeenCalledWith('dark')
})

test('labels unstamped builds clearly', async () => {
  const user = userEvent.setup()

  render(
    <AppMenu
      themePreference="dark"
      onThemeChange={() => undefined}
      release={{
        currentVersion: 'dev',
        latestVersion: null,
        updateAvailable: false,
        releaseURL: null,
        checkedAt: null,
        checking: false,
      }}
    />,
  )

  await user.click(screen.getByRole('button', { name: 'App menu' }))

  expect(screen.getByText('Development build')).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: /Release notes/ })).toBeInTheDocument()
})
