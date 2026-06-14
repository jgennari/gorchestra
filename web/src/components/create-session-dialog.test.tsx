import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CreateSessionDialog } from '@/components/create-session-dialog'

test('create session form submits default fake agent and optional title', async () => {
  const user = userEvent.setup()
  const onCreate = vi.fn(async () => ({
    id: 'sess_1',
    title: 'Inspect repo',
    agent_type: 'fake' as const,
    status: 'idle' as const,
    created_at: '2026-06-12T16:00:00Z',
    updated_at: '2026-06-12T16:00:00Z',
    completed_at: null,
    archived_at: null,
  }))

  render(<CreateSessionDialog open onOpenChange={() => undefined} onCreate={onCreate} />)

  await user.type(screen.getByLabelText('Title'), 'Inspect repo')
  await user.click(screen.getByRole('button', { name: /^create$/i }))

  expect(onCreate).toHaveBeenCalledWith({ agent_type: 'fake', title: 'Inspect repo' })
})
