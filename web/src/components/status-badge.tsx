import type { SessionStatus } from '@/lib/api'
import type { SessionAttention } from '@/lib/session-attention'
import { cn } from '@/lib/utils'

type Props = {
  status: SessionStatus
  className?: string
  attention?: SessionAttention | null
  hasError?: boolean
}

export function StatusBadge({ status, className, attention = null, hasError = false }: Props) {
  const label = statusBadgeLabel(status, attention, hasError)

  return (
    <span
      aria-label={label}
      role="img"
      title={label}
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-full',
        hasError && 'bg-destructive',
        !hasError &&
          (attention === 'pending-input' || attention === 'pending-permission') &&
          'animate-pulse bg-[hsl(var(--warning))]',
        !hasError && attention === 'unseen-idle' && 'bg-[hsl(var(--warning))]',
        !hasError && !attention && status === 'running' && 'animate-pulse bg-[hsl(var(--success))]',
        !hasError && !attention && status === 'failed' && 'bg-destructive',
        !hasError && !attention && status === 'idle' && 'bg-muted-foreground',
        className,
      )}
    />
  )
}

function statusBadgeLabel(status: SessionStatus, attention: SessionAttention | null, hasError: boolean) {
  if (hasError) return 'Session has an error'
  if (attention === 'pending-permission') return 'Session pending approval'
  if (attention === 'pending-input') return 'Session pending user input'
  if (attention === 'unseen-idle') return 'Session has unseen results'
  return `Session status: ${status}`
}
