import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MoveSessionDialog } from '@/components/move-session-dialog'
import type { Session } from '@/lib/api'

const root = session('sess_root', 'Root')
const moved = { ...session('sess_moved', 'Old project'), parent_session_id: root.id, lineage_depth: 1 }
const child = { ...session('sess_child', 'Nested child'), parent_session_id: moved.id, lineage_depth: 2 }
const candidate = session('sess_candidate', 'New parent')

test('searches eligible parents, previews the move, and excludes the moved subtree', async () => {
  const user = userEvent.setup()
  const onMove = vi.fn().mockResolvedValue(undefined)
  render(
    <MoveSessionDialog
      open
      session={moved}
      sessions={[root, moved, child, candidate]}
      onOpenChange={() => undefined}
      onMove={onMove}
    />,
  )

  const group = screen.getByRole('radiogroup', { name: 'Parent session' })
  expect(within(group).getByRole('radio', { name: /Top level/ })).toBeInTheDocument()
  expect(within(group).queryByRole('radio', { name: /Old project/ })).not.toBeInTheDocument()
  expect(within(group).queryByRole('radio', { name: /Nested child/ })).not.toBeInTheDocument()

  await user.type(screen.getByRole('textbox', { name: 'Search parent sessions' }), 'new')
  await user.click(within(group).getByRole('radio', { name: /New parent/ }))
  expect(screen.getByText(/will appear under/)).toHaveTextContent('Old project will appear under New parent.')
  await user.click(screen.getByRole('button', { name: 'Move' }))

  expect(onMove).toHaveBeenCalledWith('sess_candidate')
})

test('moves an existing child to the top level', async () => {
  const user = userEvent.setup()
  const onMove = vi.fn().mockResolvedValue(undefined)
  render(
    <MoveSessionDialog
      open
      session={moved}
      sessions={[root, moved, child, candidate]}
      onOpenChange={() => undefined}
      onMove={onMove}
    />,
  )

  await user.click(screen.getByRole('radio', { name: /Top level/ }))
  await user.click(screen.getByRole('button', { name: 'Move' }))

  expect(onMove).toHaveBeenCalledWith(null)
})

function session(id: string, title: string): Session {
  return {
    id,
    title,
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
}
