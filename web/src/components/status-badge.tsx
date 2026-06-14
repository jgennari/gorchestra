import type { SessionStatus } from '@/lib/api'
import { cn } from '@/lib/utils'

type Props = {
  status: SessionStatus
  className?: string
}

export function StatusBadge({ status, className }: Props) {
  return (
    <span
      aria-label={`Session status: ${status}`}
      role="img"
      title={`Session status: ${status}`}
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-full',
        status === 'running' && 'animate-pulse bg-[hsl(var(--warning))]',
        status === 'failed' && 'bg-destructive',
        status === 'idle' && 'bg-muted-foreground',
        className,
      )}
    />
  )
}
