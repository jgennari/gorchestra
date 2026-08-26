import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DashboardOverview } from '@/components/dashboard-overview'

beforeEach(() => {
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('dashboard renders reliable metrics, coverage, outcomes, and the run ledger', async () => {
  const onOpenSession = vi.fn()
  vi.stubGlobal('fetch', dashboardFetch())

  render(
    <DashboardOverview
      onOpenSession={onOpenSession}
      onOpenSessions={vi.fn()}
      onCreate={vi.fn()}
    />,
  )

  expect(await screen.findByRole('heading', { name: 'Your work at a glance' })).toBeInTheDocument()
  expect((await screen.findAllByText('75%')).length).toBeGreaterThan(0)
  expect(screen.getByText(new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(12_345))).toBeInTheDocument()
  expect(screen.getByText('$1.25')).toBeInTheDocument()
  expect(screen.getByText('1 of 4 runs · 25% coverage')).toBeInTheDocument()
  expect(screen.getAllByText('Not reported')).toHaveLength(2)
  expect(screen.getByRole('heading', { name: 'Observed outcomes' })).toBeInTheDocument()
  expect(screen.getByText('1 commit')).toBeInTheDocument()
  expect(screen.getByText('3 test runs · 3 passed')).toBeInTheDocument()
  expect(screen.getByText('Implemented the dashboard')).toBeInTheDocument()

  await userEvent.click(screen.getByText('Implemented the dashboard'))
  expect(onOpenSession).toHaveBeenCalledWith('sess_1')
})

test('dashboard drilldowns update the URL and refetch the ledger', async () => {
  const user = userEvent.setup()
  const fetch = dashboardFetch()
  vi.stubGlobal('fetch', fetch)

  render(
    <DashboardOverview
      onOpenSession={vi.fn()}
      onOpenSessions={vi.fn()}
      onCreate={vi.fn()}
    />,
  )

  await screen.findByRole('heading', { name: 'Workspaces' })
  await user.click(screen.getByRole('button', { name: /gorchestra.*2h 0m runtime/i }))

  await waitFor(() => expect(window.location.search).toContain('workspace=%2Frepo%2Fgorchestra'))
  await waitFor(() =>
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/api/dashboard/runs?') && String(url).includes('workspace=%2Frepo%2Fgorchestra'))).toBe(true),
  )

  await user.click(screen.getByRole('button', { name: '7 days' }))
  await waitFor(() => expect(window.location.search).toContain('range=7d'))
  await waitFor(() =>
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/api/dashboard?') && String(url).includes('range=7d'))).toBe(true),
  )
})

function dashboardFetch() {
  return vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path.startsWith('/api/dashboard/runs?')) {
      return jsonResponse({
        runs: [
          {
            id: 'run_1',
            session_id: 'sess_1',
            session_title: 'Dashboard session',
            kind: 'message',
            agent_type: 'codex',
            workspace_path: '/repo/gorchestra',
            status: 'completed',
            start_seq: 1,
            terminal_seq: 9,
            started_at: '2026-08-25T14:00:00Z',
            completed_at: '2026-08-25T14:10:00Z',
            duration_ms: 600_000,
            summary: 'Implemented the dashboard',
            error: '',
            tool_count: 8,
            file_count: 4,
            input_request_count: 0,
            permission_request_count: 1,
            token_count: 12_345,
            has_token_usage: true,
            cost_amount: 1.25,
            cost_currency: 'USD',
            has_cost_usage: true,
            archived: false,
            outcomes: { commits: 1, pull_requests: 0, tests: 3, tests_passed: 3, tests_failed: 0, delegations: 0 },
          },
        ],
        total: 1,
      })
    }
    if (path.startsWith('/api/dashboard?')) return jsonResponse(dashboardResponse())
    throw new Error(`unexpected URL ${path}`)
  })
}

function dashboardResponse() {
  return {
    generated_at: '2026-08-26T16:00:00Z',
    range: '30d',
    range_start: '2026-07-28T00:00:00Z',
    range_end: '2026-08-26T16:00:00Z',
    time_zone: 'America/New_York',
    bucket: 'day',
    summary: {
      runs: 5,
      completed_runs: 3,
      failed_runs: 1,
      cancelled_runs: 1,
      running_runs: 0,
      unknown_runs: 0,
      active_now: 1,
      success_rate: 0.75,
      agent_runtime_ms: 9_000_000,
      tool_calls: 42,
      files_changed: 12,
      input_requests: 2,
      permission_requests: 3,
      workspaces: 1,
      agents: 2,
    },
    activity: [
      { start: '2026-08-25T04:00:00Z', end: '2026-08-26T04:00:00Z', completed: 2, failed: 1, cancelled: 0, running: 0, unknown: 0 },
      { start: '2026-08-26T04:00:00Z', end: '2026-08-27T04:00:00Z', completed: 1, failed: 0, cancelled: 1, running: 0, unknown: 0 },
    ],
    workspaces: [{ key: '/repo/gorchestra', label: 'gorchestra', runs: 5, completed_runs: 3, failed_runs: 1, cancelled_runs: 1, running_runs: 0, success_rate: 0.75, agent_runtime_ms: 7_200_000 }],
    agents: [{ key: 'codex', label: 'Codex', runs: 5, completed_runs: 3, failed_runs: 1, cancelled_runs: 1, running_runs: 0, success_rate: 0.75, agent_runtime_ms: 7_200_000 }],
    usage: {
      tokens: 12_345,
      token_runs: 3,
      cost_runs: 1,
      eligible_runs: 4,
      costs: [{ amount: 1.25, currency: 'USD', runs: 1 }],
    },
    outcomes: [
      { kind: 'commit', count: 1, passed: 0, failed: 0, reported: true },
      { kind: 'pull_request', count: 0, passed: 0, failed: 0, reported: false },
      { kind: 'test', count: 3, passed: 3, failed: 0, reported: true },
      { kind: 'delegation', count: 0, passed: 0, failed: 0, reported: false },
    ],
  }
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
}
