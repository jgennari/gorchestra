import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CreateSessionDialog } from '@/components/create-session-dialog'

afterEach(() => {
  vi.unstubAllGlobals()
})

test('create session form submits default codex agent and optional title', async () => {
  const user = userEvent.setup()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === '/api/workspaces/roots') {
        return jsonResponse({
          roots: [{ id: 'root_1', name: 'repo', path: '/repo', default: true }],
        })
      }
      if (String(url) === '/api/workspaces/browse?root_id=root_1') {
        return jsonResponse({
          root_id: 'root_1',
          root_path: '/repo',
          path: '',
          entries: [],
        })
      }
      throw new Error(`unexpected URL ${String(url)}`)
    }),
  )
  const onCreate = vi.fn(async () => ({
    id: 'sess_1',
    title: 'Inspect repo',
    agent_type: 'codex' as const,
    status: 'idle' as const,
    workspace_path: '/repo',
    event_count: 0,
    tool_count: 0,
    created_at: '2026-06-12T16:00:00Z',
    updated_at: '2026-06-12T16:00:00Z',
    completed_at: null,
    archived_at: null,
  }))

  render(<CreateSessionDialog open onOpenChange={() => undefined} onCreate={onCreate} />)

  expect(await screen.findByText('/repo')).toBeInTheDocument()
  expect(screen.queryByDisplayValue('/repo')).not.toBeInTheDocument()
  await user.hover(screen.getByRole('button', { name: 'Workspace root help' }))
  expect((await screen.findAllByText(/--workspace \/path\/to\/repo/)).length).toBeGreaterThan(0)
  expect(screen.getAllByText(/--workspace-root \/path/).length).toBeGreaterThan(0)
  await user.type(screen.getByLabelText('Title'), 'Inspect repo')
  await user.click(screen.getByRole('button', { name: /^create$/i }))

  expect(onCreate).toHaveBeenCalledWith({
    agent_type: 'codex',
    title: 'Inspect repo',
    workspace_path: '/repo',
  })
})

test('create session form can enable codex dangerous mode', async () => {
  const user = userEvent.setup()
  stubWorkspaceFetch()
  const onCreate = vi.fn(async () => ({
    id: 'sess_1',
    title: '',
    agent_type: 'codex' as const,
    status: 'idle' as const,
    workspace_path: '/repo',
    event_count: 0,
    tool_count: 0,
    created_at: '2026-06-12T16:00:00Z',
    updated_at: '2026-06-12T16:00:00Z',
    completed_at: null,
    archived_at: null,
  }))

  render(<CreateSessionDialog open onOpenChange={() => undefined} onCreate={onCreate} />)

  expect(await screen.findByText('/repo')).toBeInTheDocument()
  await user.click(screen.getByLabelText(/run dangerously/i))
  await user.click(screen.getByRole('button', { name: /^create$/i }))

  expect(onCreate).toHaveBeenCalledWith({
    agent_type: 'codex',
    title: undefined,
    workspace_path: '/repo',
    agent_options: { codex: { run_dangerously: true } },
  })
})

test('create session form can enable claude dangerous mode', async () => {
  const user = userEvent.setup()
  stubWorkspaceFetch()
  const onCreate = vi.fn(async () => ({
    id: 'sess_1',
    title: '',
    agent_type: 'claude' as const,
    status: 'idle' as const,
    workspace_path: '/repo',
    event_count: 0,
    tool_count: 0,
    created_at: '2026-06-12T16:00:00Z',
    updated_at: '2026-06-12T16:00:00Z',
    completed_at: null,
    archived_at: null,
  }))

  render(<CreateSessionDialog open onOpenChange={() => undefined} onCreate={onCreate} />)

  expect(await screen.findByText('/repo')).toBeInTheDocument()
  const nativeSelect = document.querySelector('select')
  if (!nativeSelect) throw new Error('expected native select')
  fireEvent.change(nativeSelect, { target: { value: 'claude' } })
  await user.click(screen.getByLabelText(/run dangerously/i))
  await user.click(screen.getByRole('button', { name: /^create$/i }))

  expect(onCreate).toHaveBeenCalledWith({
    agent_type: 'claude',
    title: undefined,
    workspace_path: '/repo',
    agent_options: { claude: { run_dangerously: true } },
  })
})

test('workspace picker dot folders hide at root and navigate from subfolders', async () => {
  const user = userEvent.setup()
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    switch (String(url)) {
      case '/api/workspaces/roots':
        return jsonResponse({
          roots: [{ id: 'root_1', name: 'repo', path: '/repo', default: true }],
        })
      case '/api/workspaces/browse?root_id=root_1':
        return jsonResponse({
          root_id: 'root_1',
          root_path: '/repo',
          path: '',
          entries: [
            {
              name: 'src',
              path: 'src',
              type: 'directory',
              size_bytes: 0,
              modified_at: '2026-06-12T16:00:00Z',
            },
          ],
        })
      case '/api/workspaces/browse?root_id=root_1&path=src':
        return jsonResponse({
          root_id: 'root_1',
          root_path: '/repo',
          path: 'src',
          entries: [
            {
              name: 'nested',
              path: 'src/nested',
              type: 'directory',
              size_bytes: 0,
              modified_at: '2026-06-12T16:00:00Z',
            },
          ],
        })
      case '/api/workspaces/browse?root_id=root_1&path=src%2Fnested':
        return jsonResponse({
          root_id: 'root_1',
          root_path: '/repo',
          path: 'src/nested',
          entries: [],
        })
      default:
        throw new Error(`unexpected URL ${String(url)}`)
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  const requestedURLs = () => fetchMock.mock.calls.map(([url]) => String(url))

  render(<CreateSessionDialog open onOpenChange={() => undefined} onCreate={asyncSession} />)

  expect(await screen.findByRole('button', { name: 'src' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Go to parent directory' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Go to parent folder' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Go to workspace root' })).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'src' }))
  expect(await screen.findByText('/repo/src')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Go to parent folder' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Go to workspace root' })).toBeInTheDocument()

  await user.click(await screen.findByRole('button', { name: 'nested' }))
  await waitFor(() => expect(requestedURLs()).toContain('/api/workspaces/browse?root_id=root_1&path=src%2Fnested'))

  await user.click(screen.getByRole('button', { name: 'Go to parent folder' }))
  await waitFor(() =>
    expect(requestedURLs().filter((url) => url === '/api/workspaces/browse?root_id=root_1&path=src')).toHaveLength(2),
  )

  await user.click(screen.getByRole('button', { name: 'Go to workspace root' }))
  await waitFor(() =>
    expect(requestedURLs().filter((url) => url === '/api/workspaces/browse?root_id=root_1')).toHaveLength(2),
  )
  expect(screen.queryByRole('button', { name: 'Go to parent folder' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Go to workspace root' })).not.toBeInTheDocument()
})

function stubWorkspaceFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === '/api/workspaces/roots') {
        return jsonResponse({
          roots: [{ id: 'root_1', name: 'repo', path: '/repo', default: true }],
        })
      }
      if (String(url) === '/api/workspaces/browse?root_id=root_1') {
        return jsonResponse({
          root_id: 'root_1',
          root_path: '/repo',
          path: '',
          entries: [],
        })
      }
      throw new Error(`unexpected URL ${String(url)}`)
    }),
  )
}

async function asyncSession() {
  return {
    id: 'sess_1',
    title: '',
    agent_type: 'codex' as const,
    status: 'idle' as const,
    workspace_path: '/repo',
    event_count: 0,
    tool_count: 0,
    created_at: '2026-06-12T16:00:00Z',
    updated_at: '2026-06-12T16:00:00Z',
    completed_at: null,
    archived_at: null,
  }
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
