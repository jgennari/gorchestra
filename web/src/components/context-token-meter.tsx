import type { TokenUsageSummary } from '@/lib/events'
import { formatTokenCount } from '@/lib/token-count'
import { cn } from '@/lib/utils'

export function ContextTokenMeter({ usage, compact = false }: {
  usage: TokenUsageSummary | null
  compact?: boolean
}) {
  if (!usage) {
    return <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
      <span className="font-medium">Context</span><span>No token usage yet</span>
    </div>
  }

  const tokens = usage.last.totalTokens > 0 ? usage.last.totalTokens : usage.total.totalTokens
  const percent = tokens / usage.modelContextWindow
  const counts = `${formatTokenCount(tokens)} / ${formatTokenCount(usage.modelContextWindow)}`
  const percentage = `${Math.round(percent * 100)}%`
  const pressureText = percent >= 0.9 ? 'text-destructive' : percent >= 0.7 ? 'text-amber-700 dark:text-amber-400' : 'text-foreground'
  const pressureBar = percent >= 0.9 ? 'bg-destructive' : percent >= 0.7 ? 'bg-[hsl(var(--warning))]' : 'bg-primary'

  return <div>
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] font-medium text-muted-foreground">Context</span>
      <div className="flex items-baseline gap-2 whitespace-nowrap tabular-nums">
        {compact ? <span className="text-[11px] text-muted-foreground">{counts}</span> : null}
        <span className={cn('text-xs font-semibold', pressureText)}>{percentage}</span>
      </div>
    </div>
    <div
      role="meter"
      aria-label="Context token usage"
      aria-valuemin={0}
      aria-valuemax={usage.modelContextWindow}
      aria-valuenow={Math.min(Math.max(tokens, 0), usage.modelContextWindow)}
      aria-valuetext={`${tokens.toLocaleString()} of ${usage.modelContextWindow.toLocaleString()} tokens (${percentage})`}
      title={`${tokens.toLocaleString()} / ${usage.modelContextWindow.toLocaleString()} context tokens`}
      className={cn('mt-1 overflow-hidden rounded-full bg-surface-muted', compact ? 'h-1' : 'h-1.5')}
    >
      <div className={cn('h-full rounded-full', pressureBar)} style={{ width: `${Math.min(Math.max(percent * 100, 0), 100)}%` }} />
    </div>
    {!compact ? <p className="mt-1 truncate text-[11px] text-muted-foreground">{counts} current</p> : null}
  </div>
}
