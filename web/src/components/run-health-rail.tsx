import { Activity, Archive, Clock3, Eraser, Gauge, Loader2, Minimize2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { AgentEvent, Session, WorkspaceFileContent } from '@/lib/api'
import type { StreamState } from '@/hooks/use-session-events'
import type { TokenUsageSummary } from '@/lib/events'
import { eventLabel, groupEvents, latestTokenUsage } from '@/lib/events'
import { Button } from '@/components/ui/button'
import { WorkspaceFileBrowser } from '@/components/workspace-files'
import { cn } from '@/lib/utils'

type Props = {
  session: Session | null
  resolvingSessionID?: string | null
  events: AgentEvent[]
  streamState: StreamState
  streamError: string
  onClear?: () => Promise<void>
  onCompact?: () => Promise<void>
  onToggleArchive: () => Promise<void>
  onOpenFile?: (file: WorkspaceFileContent) => void
  fileRefreshKey?: number
  showFiles?: boolean
  clearPending?: boolean
  compactPending?: boolean
  archivePending?: boolean
}

export function RunHealthRail({
  session,
  resolvingSessionID = null,
  events,
  streamState,
  streamError,
  onClear = async () => undefined,
  onCompact = async () => undefined,
  onToggleArchive,
  onOpenFile,
  fileRefreshKey = 0,
  showFiles = true,
  clearPending = false,
  compactPending = false,
  archivePending = false,
}: Props) {
  const latestEvent = events.at(-1)
  const tokenUsage = latestTokenUsage(events)
  const totalEventCount = Math.max(session?.event_count ?? 0, events.length)
  const loadedToolCount = groupEvents(events).filter(
    (group) => group.kind === 'tool-call' || group.kind === 'file-change',
  ).length
  const totalToolCount = Math.max(session?.tool_count ?? 0, loadedToolCount)
  const actionPending = clearPending || compactPending
  const codexActionDisabled =
    !session || session.agent_type !== 'codex' || session.status === 'running' || Boolean(session.archived_at) || actionPending
  const compactDisabled = codexActionDisabled || !session?.provider_session_id
  const showCodexActions = session?.agent_type === 'codex'
  const showTokenPanel = Boolean(tokenUsage) || showCodexActions

  return (
    <aside className="command-rail flex h-full w-full shrink-0 flex-col px-3 py-4">
      <div className="space-y-3">
        <RailPanel>
          <div className="flex items-center justify-between gap-2">
            <RailSectionTitle icon={Activity} label="Activity" />
            <ActiveChatDot
              active={Boolean(session)}
              running={session?.status === 'running'}
              state={streamState}
              error={streamError}
            />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Metric label="Events" value={totalEventCount} />
            <Metric label="Tools" value={totalToolCount} />
          </div>
          <div className="mt-3 border-t border-border/60 pt-3">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <Clock3 className="size-3" aria-hidden="true" />
              <span>Latest</span>
            </div>
            <div className="mt-1 flex w-full min-w-0 items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-xs font-medium">
                {latestEvent ? eventLabel(latestEvent) : 'No events'}
              </p>
              <p className="ml-auto shrink-0 text-right text-[11px] text-muted-foreground">
                {latestEvent ? formatShortDateTime(latestEvent.created_at) : 'Waiting for activity'}
              </p>
            </div>
          </div>
        </RailPanel>
      </div>

      {showFiles ? (
        <div className="mt-3 min-h-0 flex-1">
          <WorkspaceFileBrowser
            session={session}
            resolvingSessionID={resolvingSessionID}
            refreshKey={fileRefreshKey}
            onOpenFile={onOpenFile}
          />
        </div>
      ) : null}

      <div className="mt-auto space-y-3 pt-3">
        {showTokenPanel ? (
          <RailPanel>
            <RailSectionTitle icon={Gauge} label="Tokens" />
            {tokenUsage ? <TokenUsageView usage={tokenUsage} /> : <TokenUsageEmptyState />}
            {showCodexActions ? (
              <CodexContextActions
                clearPending={clearPending}
                compactPending={compactPending}
                clearDisabled={codexActionDisabled}
                compactDisabled={compactDisabled}
                onClear={onClear}
                onCompact={onCompact}
              />
            ) : null}
          </RailPanel>
        ) : null}

        <Button
          type="button"
          variant="outline"
          className={cn(
            'w-full justify-start border-border/70 bg-background/40 text-muted-foreground hover:bg-background/70',
            session?.archived_at &&
              'border-[hsl(var(--warning)/0.32)] bg-[hsl(var(--warning)/0.10)] text-[hsl(var(--warning))] hover:bg-[hsl(var(--warning)/0.14)]',
          )}
          disabled={!session || session.status === 'running' || archivePending}
          onClick={() => void onToggleArchive()}
          aria-label={session?.archived_at ? 'Restore selected session' : 'Archive selected session'}
        >
          <Archive aria-hidden="true" />
          {archivePending ? (session?.archived_at ? 'Restoring' : 'Archiving') : session?.archived_at ? 'Restore' : 'Archive'}
        </Button>
      </div>
    </aside>
  )
}

function ActiveChatDot({
  active,
  running,
  state,
  error,
}: {
  active: boolean
  running: boolean
  state: StreamState
  error: string
}) {
  const label = active ? activeChatLabel(running, state, error) : 'Inactive'
  return (
    <span
      aria-label={`Active chat: ${label}`}
      role="img"
      title={`Active chat: ${label}`}
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-full',
        active ? activeChatClassName(running, state, error) : 'bg-muted-foreground',
        active && (running || state === 'loading' || state === 'reconnecting') && 'animate-pulse',
      )}
    />
  )
}

function RailPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-md border border-border/70 bg-background/46 p-3 shadow-sm', className)}>
      {children}
    </section>
  )
}

function RailSectionTitle({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
      <Icon className="size-3.5" aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded bg-surface-muted/72 px-2 py-2 text-center">
      <p className="text-lg font-semibold tabular-nums leading-none">{formatCompactCount(value)}</p>
      <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
    </div>
  )
}

function TokenUsageView({ usage }: { usage: TokenUsageSummary }) {
  const contextOnly = usage.kind === 'context'
  const contextTokens = usage.last.totalTokens > 0 ? usage.last.totalTokens : usage.total.totalTokens
  const contextPercent = contextTokens / usage.modelContextWindow
  const cachedPercent = usage.total.inputTokens > 0 ? usage.total.cachedInputTokens / usage.total.inputTokens : 0

  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">Context</span>
        <span className={cn('text-xs font-semibold tabular-nums', tokenPressureClassName(contextPercent))}>
          {formatPercent(contextPercent)}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-muted">
        <div
          className={cn('h-full rounded-full', tokenPressureBarClassName(contextPercent))}
          style={{ width: `${Math.min(Math.max(contextPercent * 100, 0), 100)}%` }}
        />
      </div>
      <p className="mt-1 truncate text-[11px] text-muted-foreground">
        {formatTokenCount(contextTokens)} / {formatTokenCount(usage.modelContextWindow)} current
      </p>
      {contextOnly ? (
        usage.cost ? (
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{formatCost(usage.cost)} cost</p>
        ) : null
      ) : (
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {formatTokenCount(usage.total.totalTokens)} cumulative
        </p>
      )}

      {contextOnly ? null : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <TokenMetric label="Input" value={usage.total.inputTokens} />
            <TokenMetric label="Output" value={usage.total.outputTokens} />
          </div>
          <p className="mt-2 truncate text-[11px] text-muted-foreground">
            {formatTokenCount(usage.total.cachedInputTokens)} cached ({formatPercent(cachedPercent)})
          </p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {formatTokenCount(usage.total.reasoningOutputTokens)} reasoning
          </p>
        </>
      )}
    </div>
  )
}

function TokenUsageEmptyState() {
  return <p className="mt-3 text-[11px] text-muted-foreground">No token usage yet</p>
}

function CodexContextActions({
  clearPending,
  compactPending,
  clearDisabled,
  compactDisabled,
  onClear,
  onCompact,
}: {
  clearPending: boolean
  compactPending: boolean
  clearDisabled: boolean
  compactDisabled: boolean
  onClear: () => Promise<void>
  onCompact: () => Promise<void>
}) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-2">
      <Button
        type="button"
        variant="outline"
        className="justify-center border-border/70 bg-background/40 px-2 text-muted-foreground hover:bg-background/70"
        disabled={clearDisabled}
        onClick={() => void onClear()}
        aria-label="Clear Codex context"
      >
        {clearPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Eraser aria-hidden="true" />}
        <span>{clearPending ? 'Clearing' : 'Clear'}</span>
      </Button>
      <Button
        type="button"
        variant="outline"
        className="justify-center border-border/70 bg-background/40 px-2 text-muted-foreground hover:bg-background/70"
        disabled={compactDisabled}
        onClick={() => void onCompact()}
        aria-label="Compact Codex context"
      >
        {compactPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Minimize2 aria-hidden="true" />}
        <span>{compactPending ? 'Compacting' : 'Compact'}</span>
      </Button>
    </div>
  )
}

function TokenMetric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-sm font-semibold tabular-nums leading-none">{formatTokenCount(value)}</p>
      <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
    </div>
  )
}

function streamStateLabel(state: StreamState, error: string) {
  if (error || state === 'disconnected') return 'Disconnected'
  if (state === 'connected') return 'Live'
  if (state === 'reconnecting') return 'Reconnecting'
  return 'Loading'
}

function activeChatLabel(running: boolean, state: StreamState, error: string) {
  if (error || state === 'disconnected') return 'Disconnected'
  if (running) return 'Running'
  return streamStateLabel(state, error)
}

function streamStateClassName(state: StreamState, error: string) {
  if (error || state === 'disconnected') return 'bg-destructive'
  if (state === 'connected') return 'bg-[hsl(var(--success))]'
  if (state === 'reconnecting') return 'bg-[hsl(var(--warning))]'
  return 'bg-muted-foreground'
}

function activeChatClassName(running: boolean, state: StreamState, error: string) {
  if (error || state === 'disconnected') return 'bg-destructive'
  if (running) return 'bg-[hsl(var(--success))]'
  return streamStateClassName(state, error)
}

function tokenPressureClassName(percent: number) {
  if (percent >= 0.9) return 'text-destructive'
  if (percent >= 0.7) return 'text-amber-700 dark:text-amber-400'
  return 'text-foreground'
}

function tokenPressureBarClassName(percent: number) {
  if (percent >= 0.9) return 'bg-destructive'
  if (percent >= 0.7) return 'bg-[hsl(var(--warning))]'
  return 'bg-primary'
}

function formatTokenCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function formatCompactCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`
}

function formatCost(cost: { amount: number; currency: string }) {
  const currency = cost.currency.toUpperCase()
  if (currency === 'USD') {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: cost.amount < 1 ? 4 : 2,
    }).format(cost.amount)
  }
  return `${formatCompactCount(cost.amount)} ${currency}`
}

function formatShortDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}
