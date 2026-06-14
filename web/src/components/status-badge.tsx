import type { SessionStatus } from '@/lib/api'
import { cn } from '@/lib/utils'

type Props = {
  status: SessionStatus
  className?: string
  connected?: boolean
}

export function StatusBadge({ status, className, connected = false }: Props) {
  const label = connected ? 'Session connected to backend' : `Session status: ${status}`

  return (
    <span
      aria-label={label}
      role="img"
      title={label}
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-full',
        connected
          ? [
              'bg-[hsl(var(--success))]',
              status === 'running' && 'animate-pulse',
            ]
          : [
              status === 'running' && 'animate-pulse bg-[hsl(var(--success))]',
              status === 'failed' && 'bg-destructive',
              status === 'idle' && 'bg-muted-foreground',
            ],
        className,
      )}
    />
  )
}
