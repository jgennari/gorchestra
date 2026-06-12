import { Plus } from 'lucide-react'
import type { Session, SessionStatus } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StatusBadge } from '@/components/status-badge'
import { cn } from '@/lib/utils'

type Filter = 'all' | SessionStatus

type Props = {
  sessions: Session[]
  selectedSessionID: string | null
  filter: Filter
  onFilterChange: (filter: Filter) => void
  onSelect: (sessionID: string) => void
  onCreate: () => void
}

const filters: Filter[] = ['all', 'running', 'idle', 'completed', 'failed', 'cancelled']

export function SessionList({
  sessions,
  selectedSessionID,
  filter,
  onFilterChange,
  onSelect,
  onCreate,
}: Props) {
  const visibleSessions =
    filter === 'all' ? sessions : sessions.filter((session) => session.status === filter)

  return (
    <aside className="flex min-h-0 flex-col border-r bg-sidebar">
      <div className="flex items-center justify-between gap-3 border-b p-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase text-muted-foreground">Gorchestra</p>
          <h1 className="truncate text-lg font-semibold">Sessions</h1>
        </div>
        <Button aria-label="Create session" size="icon" onClick={onCreate}>
          <Plus />
        </Button>
      </div>

      <div className="border-b p-3">
        <Tabs value={filter} onValueChange={(value) => onFilterChange(value as Filter)}>
          <TabsList className="grid h-auto w-full grid-cols-3 gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {filters.map((item) => (
              <TabsTrigger key={item} value={item} className="min-w-0">
                {item}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <ScrollArea className="flex-1">
        {visibleSessions.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">No sessions match this view.</div>
        ) : (
          <div className="space-y-2 p-3">
            {visibleSessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => onSelect(session.id)}
                className={cn(
                  'w-full rounded-lg border bg-card p-3 text-left shadow-sm transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selectedSessionID === session.id && 'border-primary bg-accent',
                )}
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {session.title || 'Untitled session'}
                    </span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">
                      {session.agent_type} · {formatShortTime(session.updated_at)}
                    </span>
                  </span>
                  <StatusBadge status={session.status} />
                </span>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </aside>
  )
}

function formatShortTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}
