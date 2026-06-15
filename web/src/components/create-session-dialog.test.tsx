import { render, screen } from '@testing-library/react'
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

  expect(await screen.findByDisplayValue('/repo')).toBeInTheDocument()
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

  expect(await screen.findByDisplayValue('/repo')).toBeInTheDocument()
  await user.click(screen.getByLabelText(/run dangerously/i))
  await user.click(screen.getByRole('button', { name: /^create$/i }))

  expect(onCreate).toHaveBeenCalledWith({
    agent_type: 'codex',
    title: undefined,
    workspace_path: '/repo',
    agent_options: { codex: { run_dangerously: true } },
  })
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

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
