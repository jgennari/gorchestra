import { Plus } from 'lucide-react'
import type { Session, SessionListFilter } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StatusBadge } from '@/components/status-badge'
import { cn } from '@/lib/utils'

type Props = {
  sessions: Session[]
  selectedSessionID: string | null
  filter: SessionListFilter
  onFilterChange: (filter: SessionListFilter) => void
  onSelect: (sessionID: string) => void
  onCreate: () => void
}

const filters: SessionListFilter[] = ['all', 'running', 'failed']

export function SessionList({
  sessions,
  selectedSessionID,
  filter,
  onFilterChange,
  onSelect,
  onCreate,
}: Props) {
  return (
    <aside className="flex h-full w-full min-h-0 flex-col border-r bg-sidebar">
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
        <Tabs value={filter} onValueChange={(value) => onFilterChange(value as SessionListFilter)}>
          <TabsList className="grid h-auto w-full grid-cols-3 gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {filters.map((item) => (
              <TabsTrigger key={item} value={item} className="min-w-0">
                {filterLabel(item)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <ScrollArea className="flex-1">
        {sessions.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            {filter === 'all' ? 'No sessions yet.' : 'No sessions match this view.'}
          </div>
        ) : (
          <div className="space-y-1 p-2">
            {sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => onSelect(session.id)}
                aria-current={selectedSessionID === session.id ? 'true' : undefined}
                className={cn(
                  'grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  selectedSessionID === session.id && 'bg-accent',
                )}
              >
                <StatusBadge status={session.status} />
                <span className="min-w-0 truncate text-sm font-medium">
                  {session.title || 'Untitled session'}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {session.agent_type} · {formatShortTime(session.updated_at)}
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

function filterLabel(filter: SessionListFilter) {
  return filter === 'all' ? 'All' : filter[0].toUpperCase() + filter.slice(1)
}
