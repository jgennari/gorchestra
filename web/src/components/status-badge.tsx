import type { SessionStatus } from '@/lib/api'
import { cn } from '@/lib/utils'

export type SessionAttention = 'pending-input' | 'unseen-idle'

type Props = {
  status: SessionStatus
  className?: string
  attention?: SessionAttention | null
}

export function StatusBadge({ status, className, attention = null }: Props) {
  const label = statusBadgeLabel(status, attention)

  return (
    <span
      aria-label={label}
      role="img"
      title={label}
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-full',
        attention === 'pending-input' && 'animate-pulse bg-[hsl(var(--warning))]',
        attention === 'unseen-idle' && 'bg-[hsl(var(--warning))]',
        !attention && status === 'running' && 'animate-pulse bg-[hsl(var(--success))]',
        !attention && status === 'failed' && 'bg-destructive',
        !attention && status === 'idle' && 'bg-muted-foreground',
        className,
      )}
    />
  )
}

function statusBadgeLabel(status: SessionStatus, attention: SessionAttention | null) {
  if (attention === 'pending-input') return 'Session pending user input'
  if (attention === 'unseen-idle') return 'Session has unseen results'
  return `Session status: ${status}`
}
