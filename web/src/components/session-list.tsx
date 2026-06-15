import { Plus, Search } from 'lucide-react'
import { useState } from 'react'
import type { Session } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { StatusBadge } from '@/components/status-badge'
import { ThemeToggle } from '@/components/theme-toggle'
import type { ResolvedTheme, ThemePreference } from '@/hooks/use-theme'
import { sessionAttention } from '@/lib/session-attention'
import { cn } from '@/lib/utils'

type Props = {
  sessions: Session[]
  selectedSessionID: string | null
  lastSeenSeqBySession?: Record<string, number>
  onSelect: (sessionID: string) => void
  onCreate: () => void
  themePreference: ThemePreference
  resolvedTheme: ResolvedTheme
  onThemeToggle: () => void
  variant?: 'full' | 'embedded'
}

export function SessionList({
  sessions,
  selectedSessionID,
  lastSeenSeqBySession = {},
  onSelect,
  onCreate,
  themePreference,
  resolvedTheme,
  onThemeToggle,
  variant = 'full',
}: Props) {
  const [query, setQuery] = useState('')
  const visibleSessions = filterSessions(sessions, query)
  const showHeader = variant === 'full'

  return (
    <aside
      aria-label="Sessions"
      className={cn(
        'flex h-full w-full min-h-0 flex-col',
        variant === 'full' ? 'command-sidebar border-r border-border/70' : 'bg-transparent',
      )}
    >
      {showHeader ? (
        <div className="flex items-center justify-between gap-3 border-b border-border/70 p-4">
          <img src="/icon.svg" alt="Gorchestra" className="sidebar-logo-mark size-[2.0625rem] shrink-0" />
          <div className="flex shrink-0 items-center gap-2">
            <ThemeToggle
              preference={themePreference}
              resolvedTheme={resolvedTheme}
              onToggle={onThemeToggle}
            />
            <Button aria-label="Create session" size="icon" onClick={onCreate} className="shadow-sm">
              <Plus />
            </Button>
          </div>
        </div>
      ) : null}

      <div className="border-b border-border/70 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            aria-label="Search sessions"
            placeholder="Search sessions..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 bg-background/60 pl-8"
          />
        </div>
      </div>

      <ScrollArea className="flex-1">
        {visibleSessions.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            {sessions.length === 0 ? 'No sessions yet.' : 'No sessions match your search.'}
          </div>
        ) : (
          <div className="session-list-rows space-y-1.5 p-2.5">
            {visibleSessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => onSelect(session.id)}
                aria-current={selectedSessionID === session.id ? 'true' : undefined}
                className={cn(
                  'session-row grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-transparent px-2.5 py-2 text-left transition-colors hover:border-border/70 hover:bg-background/54 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  selectedSessionID === session.id && 'border-primary/30 bg-background/80 shadow-sm',
                )}
              >
                <StatusBadge status={session.status} attention={sessionAttention(session, lastSeenSeqBySession)} />
                <span className="min-w-0 truncate text-sm font-medium">
                  {session.title || 'Untitled session'}
                </span>
                <span className="session-row-meta shrink-0 rounded bg-surface-muted/72 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {session.agent_type} / {formatShortTime(session.updated_at)}
                </span>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </aside>
  )
}

function filterSessions(sessions: Session[], query: string) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return sessions
  }

  return sessions.filter((session) => sessionSearchText(session).includes(normalizedQuery))
}

function sessionSearchText(session: Session) {
  return [
    session.id,
    session.title,
    session.agent_type,
    session.status,
  ].join(' ').toLowerCase()
}

function formatShortTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}
