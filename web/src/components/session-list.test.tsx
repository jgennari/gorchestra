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
    created_at: '2026-06-12T16:00:00Z',
    updated_at: '2026-06-12T16:10:00Z',
    completed_at: null,
  },
]

test('session list exposes sprint status filters', async () => {
  const user = userEvent.setup()
  const onFilterChange = vi.fn()

  render(
    <SessionList
      sessions={sessions}
      selectedSessionID={null}
      filter="all"
      onFilterChange={onFilterChange}
      onSelect={() => undefined}
      onCreate={() => undefined}
    />,
  )

  expect(screen.queryByRole('tab', { name: 'Idle' })).not.toBeInTheDocument()

  await user.click(screen.getByRole('tab', { name: 'Running' }))

  expect(onFilterChange).toHaveBeenCalledWith('running')
})

test('session rows are keyboard selectable', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()

  render(
    <SessionList
      sessions={sessions}
      selectedSessionID={null}
      filter="all"
      onFilterChange={() => undefined}
      onSelect={onSelect}
      onCreate={() => undefined}
    />,
  )

  screen.getByRole('button', { name: /running work/i }).focus()
  await user.keyboard('{Enter}')

  expect(onSelect).toHaveBeenCalledWith('sess_running')
})
