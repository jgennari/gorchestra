import { Activity, Archive, Clock3, Gauge } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { AgentEvent, Session } from '@/lib/api'
import type { StreamState } from '@/hooks/use-session-events'
import type { TokenUsageSummary } from '@/lib/events'
import { eventLabel, groupEvents, latestTokenUsage } from '@/lib/events'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Props = {
  session: Session | null
  events: AgentEvent[]
  streamState: StreamState
  streamError: string
  onArchive: () => Promise<void>
  archivePending?: boolean
}

export function RunHealthRail({
  session,
  events,
  streamState,
  streamError,
  onArchive,
  archivePending = false,
}: Props) {
  const toolCount = groupEvents(events).filter((group) => group.kind === 'tool-call' || group.kind === 'file-change').length
  const latestEvent = events.at(-1)
  const tokenUsage = latestTokenUsage(events)

  return (
    <aside className="command-rail flex h-full w-[232px] shrink-0 flex-col px-3 py-4">
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
            <Metric label="Events" value={events.length} />
            <Metric label="Tools" value={toolCount} />
          </div>
        </RailPanel>

        <RailPanel>
          <RailSectionTitle icon={Clock3} label="Latest" />
          <div className="mt-2 min-w-0">
            <p className="truncate text-xs font-medium">{latestEvent ? eventLabel(latestEvent) : 'No events'}</p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {latestEvent ? formatShortDateTime(latestEvent.created_at) : 'Waiting for activity'}
            </p>
          </div>
        </RailPanel>
      </div>

      <div className="mt-auto space-y-3 pt-3">
        {tokenUsage ? (
          <RailPanel>
            <RailSectionTitle icon={Gauge} label="Tokens" />
            <TokenUsageView usage={tokenUsage} />
          </RailPanel>
        ) : null}

        <Button
          type="button"
          variant="outline"
          className="w-full justify-start border-border/70 bg-background/40 text-muted-foreground hover:bg-background/70"
          disabled={!session || session.status === 'running' || archivePending}
          onClick={() => void onArchive()}
          aria-label="Archive selected session"
        >
          <Archive aria-hidden="true" />
          {archivePending ? 'Archiving' : 'Archive'}
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

function RailPanel({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-md border border-border/70 bg-background/46 p-3 shadow-sm">
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
    <div className="rounded bg-surface-muted/72 px-2 py-2">
      <p className="text-lg font-semibold tabular-nums leading-none">{value}</p>
      <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
    </div>
  )
}

function TokenUsageView({ usage }: { usage: TokenUsageSummary }) {
  const contextPercent = usage.total.totalTokens / usage.modelContextWindow
  const cachedPercent = usage.total.inputTokens > 0 ? usage.total.cachedInputTokens / usage.total.inputTokens : 0
  const lastTurnVisible = usage.last.totalTokens > 0 && usage.last.totalTokens !== usage.total.totalTokens

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
        {formatTokenCount(usage.total.totalTokens)} / {formatTokenCount(usage.modelContextWindow)}
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <TokenMetric label="Input" value={usage.total.inputTokens} />
        <TokenMetric label="Output" value={usage.total.outputTokens} />
      </div>
      <p className="mt-2 truncate text-[11px] text-muted-foreground">
        {formatTokenCount(usage.total.cachedInputTokens)} cached ({formatPercent(cachedPercent)})
      </p>
      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {formatTokenCount(usage.total.reasoningOutputTokens)} reasoning
        {lastTurnVisible ? ` · ${formatTokenCount(usage.last.totalTokens)} last turn` : ''}
      </p>
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

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`
}

function formatShortDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}
