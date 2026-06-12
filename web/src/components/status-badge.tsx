import type { SessionStatus } from '@/lib/api'
import { Badge } from '@/components/ui/badge'

type Props = {
  status: SessionStatus
}

export function StatusBadge({ status }: Props) {
  const variant =
    status === 'completed'
      ? 'success'
      : status === 'running'
        ? 'warning'
        : status === 'failed' || status === 'cancelled'
          ? 'destructive'
          : 'outline'

  return <Badge variant={variant}>{status}</Badge>
}
