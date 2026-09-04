import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Code2,
  FileCode2,
  GitCommitHorizontal,
  GitPullRequest,
  Layers3,
  LoaderCircle,
  Menu,
  Network,
  Plus,
  RefreshCw,
  TestTube2,
  Wrench,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  getDashboard,
  listDashboardRuns,
  type DashboardActivityBucket,
  type DashboardBreakdown,
  type DashboardData,
  type DashboardOutcomeKind,
  type DashboardRange,
  type DashboardRun,
  type DashboardRunFilters,
  type DashboardRunPage,
  type DashboardRunStatus,
} from '@/lib/api'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Props = {
  refreshKey?: number
  onOpenSession: (sessionID: string) => void
  onOpenSessions: () => void
  onCreate: () => void
}

const rangeOptions: Array<{ value: DashboardRange; label: string }> = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' },
]

const statusOrder: DashboardRunStatus[] = ['completed', 'failed', 'cancelled', 'running', 'unknown']

export function DashboardOverview({ refreshKey = 0, onOpenSession, onOpenSessions, onCreate }: Props) {
  const initialURLState = useMemo(() => dashboardStateFromURL(), [])
  const [range, setRange] = useState(initialURLState.range)
  const [filters, setFilters] = useState<DashboardRunFilters>(initialURLState.filters)
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [runPage, setRunPage] = useState<DashboardRunPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const loadRequestRef = useRef(0)
  const loadAbortControllerRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    const requestID = loadRequestRef.current + 1
    loadRequestRef.current = requestID
    loadAbortControllerRef.current?.abort()
    const controller = new AbortController()
    loadAbortControllerRef.current = controller
    setLoading(true)
    setError('')
    try {
      const [nextDashboard, nextRuns] = await Promise.all([
        getDashboard(range, controller.signal),
        listDashboardRuns(range, filters, '', 25, controller.signal),
      ])
      if (controller.signal.aborted || loadRequestRef.current !== requestID) return
      setDashboard(nextDashboard)
      setRunPage(nextRuns)
    } catch (loadError) {
      if (controller.signal.aborted || loadRequestRef.current !== requestID) return
      setError(messageFromError(loadError))
    } finally {
      if (loadRequestRef.current === requestID) {
        loadAbortControllerRef.current = null
        setLoading(false)
      }
    }
  }, [filters, range])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  useEffect(() => () => {
    loadAbortControllerRef.current?.abort()
  }, [])

  useEffect(() => {
    function handlePopState() {
      const next = dashboardStateFromURL()
      setRange(next.range)
      setFilters(next.filters)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  function updateView(nextRange: DashboardRange, nextFilters: DashboardRunFilters, history: 'push' | 'replace' = 'push') {
    setRange(nextRange)
    setFilters(nextFilters)
    const query = dashboardQuery(nextRange, nextFilters)
    window.history[history === 'replace' ? 'replaceState' : 'pushState']({}, '', query ? `/?${query}` : '/')
  }

  function updateFilters(next: DashboardRunFilters) {
    updateView(range, compactFilters(next))
  }

  function selectBreakdown(kind: 'agent' | 'workspace', value: string) {
    updateFilters({ ...filters, [kind]: filters[kind] === value ? undefined : value })
  }

  function selectOutcome(outcome: DashboardOutcomeKind) {
    updateFilters({ ...filters, outcome: filters.outcome === outcome ? undefined : outcome })
  }

  function selectBucket(bucket: DashboardActivityBucket) {
    const selected = filters.bucket_start === bucket.start && filters.bucket_end === bucket.end
    updateFilters({
      ...filters,
      bucket_start: selected ? undefined : bucket.start,
      bucket_end: selected ? undefined : bucket.end,
    })
  }

  async function loadMore() {
    if (!runPage?.next_cursor || loadingMore) return
    setLoadingMore(true)
    try {
      const next = await listDashboardRuns(range, filters, runPage.next_cursor)
      setRunPage({ ...next, runs: [...runPage.runs, ...next.runs] })
    } catch (loadError) {
      setError(messageFromError(loadError))
    } finally {
      setLoadingMore(false)
    }
  }

  const hasFilters = Object.values(filters).some(Boolean)

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="dashboard-overview-content mx-auto w-full max-w-[1480px] px-4 pb-12 sm:px-6 lg:px-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-2.5">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Open sessions"
              onClick={onOpenSessions}
              className="mt-0.5 shrink-0 lg:hidden"
            >
              <Menu />
            </Button>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Overview</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Your work at a glance</h1>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Runs, activity, outcomes, and resource usage reconstructed from Gorchestra's event history.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="icon" aria-label="Refresh dashboard" onClick={() => void load()}>
              <RefreshCw className={cn(loading && 'animate-spin')} />
            </Button>
            <Button type="button" onClick={onCreate} className="gap-2">
              <Plus className="size-4" />
              New session
            </Button>
          </div>
        </header>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-lg border border-border/70 bg-muted/50 p-1">
            {rangeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={range === option.value}
                onClick={() => updateView(option.value, filters)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  range === option.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          {dashboard ? (
            <p className="text-xs text-muted-foreground">
              Updated {formatRelativeTime(dashboard.generated_at)} · {dashboard.time_zone}
            </p>
          ) : null}
        </div>

        {error ? (
          <div role="alert" className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-[hsl(var(--danger)/0.3)] bg-[hsl(var(--danger)/0.08)] p-4 text-sm">
            <span>{error}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => void load()}>Try again</Button>
          </div>
        ) : null}

        {loading && !dashboard ? <DashboardSkeleton /> : dashboard ? (
          <>
            <KPIGrid dashboard={dashboard} onSelectStatus={(status) => updateFilters({ ...filters, status })} />

            <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(320px,0.8fr)]">
              <Panel
                title="Run activity"
                description={`${capitalize(dashboard.bucket)} buckets · select a bar to inspect its runs`}
                className="min-w-0"
              >
                <ActivityChart
                  activity={dashboard.activity}
                  selectedStart={filters.bucket_start}
                  onSelect={selectBucket}
                />
              </Panel>
              <Panel title="Runtime & operations" description="Measured from persisted run events">
                <div className="grid grid-cols-2 gap-3">
                  <SmallMetric icon={<Clock3 />} label="Agent runtime" value={formatDuration(dashboard.summary.agent_runtime_ms)} />
                  <SmallMetric icon={<Wrench />} label="Tool calls" value={formatNumber(dashboard.summary.tool_calls)} />
                  <SmallMetric icon={<FileCode2 />} label="Files changed" value={formatNumber(dashboard.summary.files_changed)} />
                  <SmallMetric icon={<Activity />} label="Input requests" value={formatNumber(dashboard.summary.input_requests)} />
                  <SmallMetric icon={<Layers3 />} label="Workspaces" value={formatNumber(dashboard.summary.workspaces)} />
                  <SmallMetric icon={<Bot />} label="Agents" value={formatNumber(dashboard.summary.agents)} />
                </div>
              </Panel>
            </div>

            <div className="mt-5 grid gap-5 xl:grid-cols-2">
              <BreakdownPanel
                title="Workspaces"
                icon={<Code2 className="size-4" />}
                rows={dashboard.workspaces}
                selected={filters.workspace}
                onSelect={(value) => selectBreakdown('workspace', value)}
              />
              <BreakdownPanel
                title="Agents"
                icon={<Bot className="size-4" />}
                rows={dashboard.agents}
                selected={filters.agent}
                onSelect={(value) => selectBreakdown('agent', value)}
              />
            </div>

            <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
              <UsagePanel dashboard={dashboard} />
              <OutcomesPanel dashboard={dashboard} selected={filters.outcome} onSelect={selectOutcome} />
            </div>
          </>
        ) : null}

        <Panel
          title="Run ledger"
          description={runPage ? `${formatNumber(runPage.total)} runs match this view` : 'Loading runs'}
          className="mt-5"
          action={
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => updateFilters({ ...filters, sort: filters.sort === 'duration' ? undefined : 'duration' })}
                className={cn(
                  'rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                  filters.sort === 'duration' ? 'border-primary/30 bg-primary/10 text-foreground' : 'border-border/70 text-muted-foreground hover:text-foreground',
                )}
              >
                {filters.sort === 'duration' ? 'Longest first' : 'Recent first'}
              </button>
              {hasFilters ? (
                <Button type="button" variant="ghost" size="sm" className="gap-1" onClick={() => updateFilters({})}>
                  <X className="size-3.5" /> Clear
                </Button>
              ) : null}
            </div>
          }
        >
          <ActiveFilters filters={filters} onChange={updateFilters} />
          {loading && !runPage ? (
            <div className="flex min-h-36 items-center justify-center text-sm text-muted-foreground">
              <LoaderCircle className="mr-2 size-4 animate-spin" /> Loading runs...
            </div>
          ) : runPage?.runs.length ? (
            <div className="mt-3 overflow-hidden rounded-lg border border-border/70">
              {runPage.runs.map((run) => <RunRow key={run.id} run={run} onOpen={() => onOpenSession(run.session_id)} />)}
            </div>
          ) : (
            <div className="mt-3 rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              No runs match this view yet.
            </div>
          )}
          {runPage?.next_cursor ? (
            <div className="mt-4 flex justify-center">
              <Button type="button" variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
                Load more
              </Button>
            </div>
          ) : null}
        </Panel>
      </div>
    </div>
  )
}

function KPIGrid({ dashboard, onSelectStatus }: { dashboard: DashboardData; onSelectStatus: (status: DashboardRunStatus) => void }) {
  const summary = dashboard.summary
  return (
    <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        icon={<Activity />}
        label="Runs"
        value={formatNumber(summary.runs)}
        detail={`${formatNumber(summary.active_now)} active now`}
      />
      <MetricCard
        icon={<CheckCircle2 />}
        label="Success rate"
        value={summary.success_rate === null ? '—' : formatPercent(summary.success_rate)}
        detail={`${formatNumber(summary.completed_runs)} completed · ${formatNumber(summary.failed_runs)} failed`}
        onClick={() => onSelectStatus('completed')}
      />
      <MetricCard
        icon={<Clock3 />}
        label="Agent runtime"
        value={formatDuration(summary.agent_runtime_ms)}
        detail={summary.runs ? `${formatDuration(Math.round(summary.agent_runtime_ms / summary.runs))} per run` : 'No runs in range'}
      />
      <MetricCard
        icon={<Wrench />}
        label="Work performed"
        value={formatNumber(summary.tool_calls)}
        detail={`${formatNumber(summary.files_changed)} files changed`}
      />
    </div>
  )
}

function MetricCard({ icon, label, value, detail, onClick }: { icon: ReactNode; label: string; value: string; detail: string; onClick?: () => void }) {
  const content = (
    <>
      <div className="flex items-center justify-between gap-3 text-muted-foreground">
        <span className="text-xs font-semibold uppercase tracking-[0.12em]">{label}</span>
        <span className="[&>svg]:size-4">{icon}</span>
      </div>
      <p className="mt-4 text-3xl font-semibold tracking-tight">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </>
  )
  const className = cn('rounded-xl border border-border/70 bg-card p-4 text-left shadow-sm', onClick && 'transition-colors hover:border-primary/40 hover:bg-muted/30')
  return onClick ? <button type="button" className={className} onClick={onClick}>{content}</button> : <div className={className}>{content}</div>
}

function ActivityChart({ activity, selectedStart, onSelect }: { activity: DashboardActivityBucket[]; selectedStart?: string; onSelect: (bucket: DashboardActivityBucket) => void }) {
  const maximum = Math.max(1, ...activity.map(bucketTotal))
  const labelEvery = Math.max(1, Math.ceil(activity.length / 7))
  if (!activity.length) return <EmptyPanel label="No activity in this range." />
  return (
    <div>
      <div className="flex h-52 items-end gap-1.5 pt-5 sm:gap-2">
        {activity.map((bucket) => {
          const total = bucketTotal(bucket)
          const height = Math.max(total ? 7 : 1, (total / maximum) * 100)
          return (
            <button
              key={bucket.start}
              type="button"
              title={`${formatBucketDate(bucket.start)}: ${total} runs`}
              aria-label={`${formatBucketDate(bucket.start)}, ${total} runs`}
              aria-pressed={selectedStart === bucket.start}
              onClick={() => onSelect(bucket)}
              className="group flex h-full min-w-0 flex-1 items-end rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                className={cn(
                  'flex w-full min-w-1 flex-col-reverse overflow-hidden rounded-sm bg-muted transition-[filter,opacity] group-hover:brightness-110',
                  selectedStart === bucket.start && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
                )}
                style={{ height: `${height}%` }}
              >
                {statusOrder.map((status) => {
                  const count = bucket[status]
                  return count ? <span key={status} className={activityStatusClass(status)} style={{ height: `${(count / total) * 100}%` }} /> : null
                })}
              </span>
            </button>
          )
        })}
      </div>
      <div className="mt-2 flex gap-1.5 sm:gap-2">
        {activity.map((bucket, index) => (
          <span key={bucket.start} className="min-w-0 flex-1 truncate text-center text-[10px] text-muted-foreground">
            {index % labelEvery === 0 || index === activity.length - 1 ? compactBucketDate(bucket.start) : ''}
          </span>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2">
        {statusOrder.map((status) => (
          <span key={status} className="inline-flex items-center gap-1.5 text-xs capitalize text-muted-foreground">
            <span className={cn('size-2 rounded-sm', activityStatusClass(status))} />{status}
          </span>
        ))}
      </div>
    </div>
  )
}

function BreakdownPanel({ title, icon, rows, selected, onSelect }: { title: string; icon: ReactNode; rows: DashboardBreakdown[]; selected?: string; onSelect: (key: string) => void }) {
  const maximum = Math.max(1, ...rows.map((row) => row.runs))
  return (
    <Panel title={title} description="Runs and measured success rate" action={<span className="text-muted-foreground">{icon}</span>}>
      {rows.length ? <div className="space-y-2">
        {rows.slice(0, 8).map((row) => (
          <button
            key={row.key}
            type="button"
            onClick={() => onSelect(row.key)}
            aria-pressed={selected === row.key}
            className={cn(
              'group relative grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 overflow-hidden rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:border-border/70',
              selected === row.key && 'border-primary/30 bg-primary/5',
            )}
          >
            <span aria-hidden="true" className="absolute inset-y-0 left-0 bg-muted/60" style={{ width: `${(row.runs / maximum) * 100}%` }} />
            <span className="relative min-w-0">
              <span className="block truncate text-sm font-medium" title={row.label}>{row.label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{formatDuration(row.agent_runtime_ms)} runtime</span>
            </span>
            <span className="relative text-right">
              <span className="block text-sm font-semibold">{formatNumber(row.runs)}</span>
              <span className="block text-xs text-muted-foreground">{row.success_rate === null ? '—' : formatPercent(row.success_rate)}</span>
            </span>
          </button>
        ))}
      </div> : <EmptyPanel label={`No ${title.toLowerCase()} in this range.`} />}
    </Panel>
  )
}

function UsagePanel({ dashboard }: { dashboard: DashboardData }) {
  const usage = dashboard.usage
  const tokenCoverage = coverageLabel(usage.token_runs, usage.eligible_runs)
  const costCoverage = coverageLabel(usage.cost_runs, usage.eligible_runs)
  return (
    <Panel title="Usage" description="Only values explicitly reported by providers are counted" action={<CircleDollarSign className="size-4 text-muted-foreground" />}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border/70 bg-muted/20 p-4">
          <p className="text-xs font-medium text-muted-foreground">Tokens reported</p>
          <p className="mt-2 text-2xl font-semibold">{formatNumber(usage.tokens)}</p>
          <CoverageBar covered={usage.token_runs} total={usage.eligible_runs} />
          <p className="mt-2 text-xs text-muted-foreground">{tokenCoverage}</p>
        </div>
        <div className="rounded-lg border border-border/70 bg-muted/20 p-4">
          <p className="text-xs font-medium text-muted-foreground">Cost reported</p>
          <p className="mt-2 text-2xl font-semibold">{formatCosts(usage.costs)}</p>
          <CoverageBar covered={usage.cost_runs} total={usage.eligible_runs} />
          <p className="mt-2 text-xs text-muted-foreground">{costCoverage}</p>
        </div>
      </div>
    </Panel>
  )
}

function OutcomesPanel({ dashboard, selected, onSelect }: { dashboard: DashboardData; selected?: DashboardOutcomeKind; onSelect: (kind: DashboardOutcomeKind) => void }) {
  const icons: Record<DashboardOutcomeKind, ReactNode> = {
    commit: <GitCommitHorizontal />,
    pull_request: <GitPullRequest />,
    test: <TestTube2 />,
    delegation: <Network />,
  }
  const labels: Record<DashboardOutcomeKind, string> = {
    commit: 'Commits', pull_request: 'Pull requests', test: 'Test runs', delegation: 'Delegations',
  }
  return (
    <Panel title="Observed outcomes" description="Derived from structured provider events and completed shell calls">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4">
        {dashboard.outcomes.map((outcome) => (
          <button
            key={outcome.kind}
            type="button"
            disabled={!outcome.reported}
            onClick={() => onSelect(outcome.kind)}
            aria-pressed={selected === outcome.kind}
            className={cn(
              'rounded-lg border border-border/70 bg-muted/20 p-3 text-left transition-colors enabled:hover:border-primary/40',
              selected === outcome.kind && 'border-primary/40 bg-primary/5',
              !outcome.reported && 'cursor-default opacity-70',
            )}
          >
            <span className="flex items-center justify-between text-muted-foreground [&>svg]:size-4">
              {icons[outcome.kind]}
              {outcome.reported ? <ChevronRight className="size-3.5" /> : null}
            </span>
            <p className="mt-3 text-lg font-semibold">{outcome.reported ? formatNumber(outcome.count) : 'Not reported'}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{labels[outcome.kind]}{outcome.kind === 'test' && outcome.reported ? ` · ${outcome.passed} passed` : ''}</p>
          </button>
        ))}
      </div>
    </Panel>
  )
}

function RunRow({ run, onOpen }: { run: DashboardRun; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-border/60 px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/40 sm:grid-cols-[minmax(0,1.5fr)_minmax(7rem,0.5fr)_minmax(8rem,0.6fr)_auto] sm:items-center sm:px-4"
    >
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{run.summary || run.session_title || 'Untitled run'}</span>
          {run.archived ? <Badge variant="outline" className="shrink-0 text-[10px]">Archived</Badge> : null}
        </span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {workspaceName(run.workspace_path)} · {formatDateTime(run.started_at)}
        </span>
        <RunOutcomeChips run={run} />
      </span>
      <span className="hidden sm:block">
        <StatusPill status={run.status} />
      </span>
      <span className="hidden text-xs text-muted-foreground sm:block">
        <span className="block capitalize">{run.agent_type || 'Unknown agent'} · {run.kind}</span>
        <span className="mt-1 block">{formatDuration(run.duration_ms)} · {run.tool_count} tools · {run.file_count} files</span>
      </span>
      <span className="flex items-center gap-2 sm:justify-end">
        <span className="sm:hidden"><StatusPill status={run.status} /></span>
        <ChevronRight className="size-4 text-muted-foreground" />
      </span>
    </button>
  )
}

function RunOutcomeChips({ run }: { run: DashboardRun }) {
  const outcomes = run.outcomes
  const chips: Array<{ key: string; label: string; icon: ReactNode; variant: BadgeProps['variant'] }> = []
  if (outcomes.commits) chips.push({
    key: 'commit',
    label: `${outcomes.commits} ${outcomes.commits === 1 ? 'commit' : 'commits'}`,
    icon: <GitCommitHorizontal />,
    variant: 'outline',
  })
  if (outcomes.pull_requests) chips.push({
    key: 'pull_request',
    label: `${outcomes.pull_requests} ${outcomes.pull_requests === 1 ? 'pull request' : 'pull requests'}`,
    icon: <GitPullRequest />,
    variant: 'outline',
  })
  if (outcomes.tests) {
    const details = [
      outcomes.tests_passed ? `${outcomes.tests_passed} passed` : '',
      outcomes.tests_failed ? `${outcomes.tests_failed} failed` : '',
    ].filter(Boolean).join(', ')
    chips.push({
      key: 'test',
      label: `${outcomes.tests} ${outcomes.tests === 1 ? 'test run' : 'test runs'}${details ? ` · ${details}` : ''}`,
      icon: <TestTube2 />,
      variant: outcomes.tests_failed ? 'destructive' : 'success',
    })
  }
  if (outcomes.delegations) chips.push({
    key: 'delegation',
    label: `${outcomes.delegations} ${outcomes.delegations === 1 ? 'delegation' : 'delegations'}`,
    icon: <Network />,
    variant: 'outline',
  })
  if (!chips.length) return null
  return (
    <span
      className="mt-2 flex flex-wrap gap-1.5"
      title="Observed from durable run events, including completed shell calls"
    >
      {chips.map((chip) => (
        <Badge key={chip.key} variant={chip.variant} className="min-h-5 gap-1 px-1.5 py-0 text-[10px] [&>svg]:size-3">
          {chip.icon}{chip.label}
        </Badge>
      ))}
    </span>
  )
}

function ActiveFilters({ filters, onChange }: { filters: DashboardRunFilters; onChange: (filters: DashboardRunFilters) => void }) {
  const chips = [
    filters.status && { key: 'status', label: `Status: ${filters.status}` },
    filters.kind && filters.kind !== 'all' && { key: 'kind', label: `Kind: ${filters.kind}` },
    filters.agent && { key: 'agent', label: `Agent: ${filters.agent}` },
    filters.workspace && { key: 'workspace', label: `Workspace: ${workspaceName(filters.workspace)}` },
    filters.outcome && { key: 'outcome', label: `Outcome: ${filters.outcome.replace('_', ' ')}` },
    filters.bucket_start && { key: 'bucket', label: `Activity: ${formatBucketDate(filters.bucket_start)}` },
  ].filter(Boolean) as Array<{ key: string; label: string }>
  if (!chips.length) return null
  return <div className="mt-3 flex flex-wrap gap-2">
    {chips.map((chip) => (
      <button
        key={chip.key}
        type="button"
        onClick={() => {
          if (chip.key === 'bucket') onChange({ ...filters, bucket_start: undefined, bucket_end: undefined })
          else onChange({ ...filters, [chip.key]: undefined })
        }}
        className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/5 px-2.5 py-1 text-xs text-foreground hover:bg-primary/10"
      >
        {chip.label}<X className="size-3" />
      </button>
    ))}
  </div>
}

function Panel({ title, description, action, className, children }: { title: string; description?: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={cn('rounded-xl border border-border/70 bg-card p-4 shadow-sm sm:p-5', className)}>
    <div className="flex items-start justify-between gap-4">
      <div><h2 className="text-base font-semibold">{title}</h2>{description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}</div>
      {action}
    </div>
    <div className="mt-4">{children}</div>
  </section>
}

function SmallMetric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
    <span className="flex items-center gap-2 text-xs text-muted-foreground [&>svg]:size-3.5">{icon}{label}</span>
    <p className="mt-2 text-lg font-semibold">{value}</p>
  </div>
}

function StatusPill({ status }: { status: DashboardRunStatus }) {
  const variants: Record<DashboardRunStatus, BadgeProps['variant']> = {
    completed: 'success', failed: 'destructive', cancelled: 'warning', running: 'secondary', unknown: 'outline',
  }
  return <Badge variant={variants[status]} className="capitalize">{status}</Badge>
}

function CoverageBar({ covered, total }: { covered: number; total: number }) {
  const percent = total ? Math.min(100, (covered / total) * 100) : 0
  return <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} /></div>
}

function EmptyPanel({ label }: { label: string }) {
  return <div className="flex min-h-28 items-center justify-center rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">{label}</div>
}

function DashboardSkeleton() {
  return <div className="mt-5 space-y-5" aria-label="Loading dashboard">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((item) => <div key={item} className="h-32 animate-pulse rounded-xl bg-muted" />)}</div>
    <div className="grid gap-5 xl:grid-cols-[1.7fr_0.8fr]"><div className="h-72 animate-pulse rounded-xl bg-muted" /><div className="h-72 animate-pulse rounded-xl bg-muted" /></div>
  </div>
}

function dashboardStateFromURL(): { range: DashboardRange; filters: DashboardRunFilters } {
  if (typeof window === 'undefined') return { range: '30d', filters: {} }
  const params = new URLSearchParams(window.location.search)
  const rawRange = params.get('range')
  const range: DashboardRange = rawRange === '7d' || rawRange === '90d' || rawRange === 'all' ? rawRange : '30d'
  const status = params.get('status')
  const kind = params.get('kind')
  const outcome = params.get('outcome')
  const sort = params.get('sort')
  return {
    range,
    filters: compactFilters({
      status: isRunStatus(status) ? status : undefined,
      kind: kind === 'message' || kind === 'compact' || kind === 'unknown' || kind === 'all' ? kind : undefined,
      agent: params.get('agent') || undefined,
      workspace: params.get('workspace') || undefined,
      outcome: isOutcome(outcome) ? outcome : undefined,
      sort: sort === 'duration' || sort === 'recent' ? sort : undefined,
      bucket_start: params.get('bucket_start') || undefined,
      bucket_end: params.get('bucket_end') || undefined,
    }),
  }
}

function dashboardQuery(range: DashboardRange, filters: DashboardRunFilters) {
  const params = new URLSearchParams()
  if (range !== '30d') params.set('range', range)
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value)
  return params.toString()
}

function compactFilters(filters: DashboardRunFilters): DashboardRunFilters {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => Boolean(value))) as DashboardRunFilters
}

function isRunStatus(value: string | null): value is DashboardRunStatus {
  return value !== null && statusOrder.includes(value as DashboardRunStatus)
}

function isOutcome(value: string | null): value is DashboardOutcomeKind {
  return value === 'commit' || value === 'pull_request' || value === 'test' || value === 'delegation'
}

function bucketTotal(bucket: DashboardActivityBucket) {
  return statusOrder.reduce((total, status) => total + bucket[status], 0)
}

function activityStatusClass(status: DashboardRunStatus) {
  return {
    completed: 'bg-[hsl(var(--success))]',
    failed: 'bg-[hsl(var(--danger))]',
    cancelled: 'bg-[hsl(var(--warning))]',
    running: 'bg-primary',
    unknown: 'bg-muted-foreground/45',
  }[status]
}

function coverageLabel(covered: number, total: number) {
  if (!total) return 'No eligible completed runs'
  return `${covered} of ${total} runs · ${Math.round((covered / total) * 100)}% coverage`
}

function formatCosts(costs: DashboardData['usage']['costs']) {
  if (!costs.length) return 'Not reported'
  return costs.map((cost) => formatCurrency(cost.amount, cost.currency)).join(' + ')
}

function formatCurrency(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount)
  } catch {
    return `${formatNumber(amount)} ${currency}`.trim()
  }
}

function formatDuration(milliseconds: number) {
  if (milliseconds < 1000) return milliseconds ? '<1s' : '0s'
  const seconds = Math.round(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

function formatPercent(value: number) {
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }).format(value)
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function formatBucketDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value))
}

function compactBucketDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value))
}

function formatRelativeTime(value: string) {
  const delta = Date.now() - new Date(value).getTime()
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  return formatDateTime(value)
}

function workspaceName(path: string) {
  if (!path) return 'No workspace'
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path
}

function capitalize(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : value
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
