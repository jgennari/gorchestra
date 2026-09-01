import { Archive, BookOpen, LayoutDashboard, Plus, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Session } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { StatusBadge } from '@/components/status-badge'
import { sessionAttention } from '@/lib/session-attention'
import { cn } from '@/lib/utils'

type Props = {
  sessions: Session[]
  selectedSessionID: string | null
  lastSeenSeqBySession?: Record<string, number>
  loading?: boolean
  onSelect: (sessionID: string) => void
  overviewSelected?: boolean
  onOverview?: () => void
  userSkillsSelected?: boolean
  onUserSkills?: () => void
  onSearch?: () => void
  onCreate: () => void
  appMenuAction?: ReactNode
  variant?: 'full' | 'embedded'
}

export function SessionList({
  sessions,
  selectedSessionID,
  lastSeenSeqBySession = {},
  loading = false,
  onSelect,
  overviewSelected = false,
  onOverview,
  userSkillsSelected = false,
  onUserSkills,
  onSearch,
  onCreate,
  appMenuAction,
  variant = 'full',
}: Props) {
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
          <button
            type="button"
            aria-label="Open overview"
            onClick={onOverview}
            className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <img src="/icon.svg" alt="Gorchestra" className="sidebar-logo-mark h-9 w-9 shrink-0" />
          </button>
          <div className="flex shrink-0 items-center gap-2">
            {appMenuAction}
            <Button aria-label="Create session" size="icon" onClick={onCreate} className="shadow-sm">
              <Plus />
            </Button>
          </div>
        </div>
      ) : null}

      <div className="border-b border-border/70 p-2.5">
        <button
          type="button"
          onClick={onOverview}
          aria-current={overviewSelected ? 'page' : undefined}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left text-sm font-medium transition-colors hover:border-border/70 hover:bg-background/54 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
            overviewSelected && 'border-primary/30 bg-background/80 shadow-sm',
          )}
        >
          <LayoutDashboard className="size-4 text-muted-foreground" />
          Overview
        </button>
        <button
          type="button"
          onClick={onUserSkills}
          aria-current={userSkillsSelected ? 'page' : undefined}
          className={cn(
            'mt-1 flex w-full items-center gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left text-sm font-medium transition-colors hover:border-border/70 hover:bg-background/54 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
            userSkillsSelected && 'border-primary/30 bg-background/80 shadow-sm',
          )}
        >
          <BookOpen className="size-4 text-muted-foreground" />
          User skills
        </button>
        <button
          type="button"
          aria-label="Search"
          onClick={onSearch}
          className="mt-1 flex w-full items-center gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left text-sm font-medium transition-colors hover:border-border/70 hover:bg-background/54 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Search className="size-4 text-muted-foreground" />
          <span className="flex-1">Search</span>
          <kbd className="rounded border border-border/70 bg-background/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {navigator.platform.toLowerCase().includes('mac') ? '⌘K' : 'Ctrl K'}
          </kbd>
        </button>
      </div>

      <ScrollArea className="flex-1">
        {loading && sessions.length === 0 ? (
          <div className="flex h-full min-h-40 items-center justify-center p-4 text-sm text-muted-foreground">
            Loading sessions...
          </div>
        ) : sessions.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">No sessions yet.</div>
        ) : (
          <div className="session-list-rows space-y-1.5 p-2.5">
            {sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => onSelect(session.id)}
                aria-current={selectedSessionID === session.id ? 'true' : undefined}
                aria-label={session.archived_at ? `${session.title || 'Untitled session'} archived` : undefined}
                className={cn(
                  'session-row grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-transparent px-2.5 py-2 text-left transition-colors hover:border-border/70 hover:bg-background/54 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  selectedSessionID === session.id && 'border-primary/30 bg-background/80 shadow-sm',
                  session.archived_at &&
                    'border-dashed border-border/80 bg-surface-muted/65 text-muted-foreground hover:border-border hover:bg-surface-muted/80',
                )}
              >
                <StatusBadge status={session.status} attention={sessionAttention(session, lastSeenSeqBySession)} />
                <span
                  className={cn(
                    'min-w-0 truncate text-sm font-medium',
                    session.archived_at && 'text-muted-foreground line-through decoration-muted-foreground/60',
                  )}
                >
                  {session.title || 'Untitled session'}
                </span>
                <span className="session-row-meta flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                  {session.archived_at ? (
                    <Badge
                      variant="warning"
                      className="min-h-5 gap-1 px-1.5 py-0 text-[10px] uppercase tracking-[0.08em]"
                    >
                      <Archive className="size-3" aria-hidden="true" />
                      Archived
                    </Badge>
                  ) : null}
                  <span className="rounded bg-surface-muted/72 px-1.5 py-0.5">
                    {session.agent_type} / {formatShortTime(session.updated_at)}
                  </span>
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
