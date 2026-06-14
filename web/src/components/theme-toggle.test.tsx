import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeToggle } from '@/components/theme-toggle'

test('theme toggle exposes the current preference and toggles on click', async () => {
  const user = userEvent.setup()
  const onToggle = vi.fn()

  render(<ThemeToggle preference="system" resolvedTheme="dark" onToggle={onToggle} />)

  await user.click(screen.getByRole('button', { name: 'Theme: System' }))

  expect(onToggle).toHaveBeenCalledOnce()
})
