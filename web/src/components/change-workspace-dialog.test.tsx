import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Session } from '@/lib/api'
import { ChangeWorkspaceDialog } from '@/components/change-workspace-dialog'

const session: Session = {
  id: 'sess_1',
  title: 'Inspect repo',
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

afterEach(() => {
  vi.unstubAllGlobals()
})

test('changes to a selected workspace', async () => {
  const user = userEvent.setup()
  stubWorkspaceFetch(false)
  const onChangeWorkspace = vi.fn(async () => undefined)

  render(
    <ChangeWorkspaceDialog
      session={session}
      open
      hasUnsavedFile={false}
      onOpenChange={() => undefined}
      onChangeWorkspace={onChangeWorkspace}
    />,
  )

  await user.click(await screen.findByRole('button', { name: 'next' }))
  await waitFor(() => expect(screen.getByTitle('/repo/next')).toBeInTheDocument())
  await user.click(screen.getByRole('button', { name: 'Change workspace' }))

  await waitFor(() => expect(onChangeWorkspace).toHaveBeenCalledWith('/repo/next'))
})

test('requires confirmation before discarding an unsaved file', async () => {
  const user = userEvent.setup()
  stubWorkspaceFetch(false)
  const onChangeWorkspace = vi.fn(async () => undefined)

  render(
    <ChangeWorkspaceDialog
      session={session}
      open
      hasUnsavedFile
      onOpenChange={() => undefined}
      onChangeWorkspace={onChangeWorkspace}
    />,
  )

  await user.click(await screen.findByRole('button', { name: 'next' }))
  await waitFor(() => expect(screen.getByTitle('/repo/next')).toBeInTheDocument())
  await user.click(screen.getByRole('button', { name: 'Change workspace' }))

  expect(onChangeWorkspace).not.toHaveBeenCalled()
  expect(screen.getByText('Discard unsaved file changes?')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Discard and change' }))
  await waitFor(() => expect(onChangeWorkspace).toHaveBeenCalledWith('/repo/next'))
})

test('blocks changes while the host console is active', async () => {
  stubWorkspaceFetch(true)

  render(
    <ChangeWorkspaceDialog
      session={session}
      open
      hasUnsavedFile={false}
      onOpenChange={() => undefined}
      onChangeWorkspace={async () => undefined}
    />,
  )

  expect(await screen.findByText('Stop the active console before changing workspace.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Change workspace' })).toBeDisabled()
})

function stubWorkspaceFetch(consoleRunning: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      switch (String(url)) {
        case '/api/sessions/sess_1/console':
          return jsonResponse({
            session_id: 'sess_1',
            workspace_path: '/repo',
            running: consoleRunning,
            attached_count: 0,
          })
        case '/api/workspaces/roots':
          return jsonResponse({ roots: [{ id: 'root_1', name: 'repo', path: '/repo', default: true }] })
        case '/api/workspaces/browse?root_id=root_1':
          return jsonResponse({
            root_id: 'root_1',
            root_path: '/repo',
            path: '',
            entries: [
              {
                name: 'next',
                path: 'next',
                type: 'directory',
                size_bytes: 0,
                modified_at: '2026-06-12T16:00:00Z',
              },
            ],
          })
        case '/api/workspaces/browse?root_id=root_1&path=next':
          return jsonResponse({ root_id: 'root_1', root_path: '/repo', path: 'next', entries: [] })
        default:
          throw new Error(`unexpected URL ${String(url)}`)
      }
    }),
  )
}

function jsonResponse(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
}
