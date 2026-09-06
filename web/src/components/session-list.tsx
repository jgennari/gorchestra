import { Archive, BookOpen, LayoutDashboard, Pin, Plus, Search } from 'lucide-react'
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
  errorSessionIDs?: ReadonlySet<string>
  lastSeenSeqBySession?: Record<string, number>
  loading?: boolean
  onSelect: (sessionID: string) => void
  pinningSessionIDs?: ReadonlySet<string>
  onPinChange?: (sessionID: string, pinned: boolean) => void
  overviewSelected?: boolean
  onOverview?: () => void
  userSkillsSelected?: boolean
  onUserSkills?: () => void
  onSearch?: () => void
  onCreate: () => void
  createDisabled?: boolean
  notificationAction?: ReactNode
  appMenuAction?: ReactNode
  variant?: 'full' | 'embedded'
}

export function SessionList({
  sessions,
  selectedSessionID,
  errorSessionIDs = new Set(),
  lastSeenSeqBySession = {},
  loading = false,
  onSelect,
  pinningSessionIDs = new Set(),
  onPinChange,
  overviewSelected = false,
  onOverview,
  userSkillsSelected = false,
  onUserSkills,
  onSearch,
  onCreate,
  createDisabled = false,
  notificationAction,
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
            {notificationAction}
            {appMenuAction}
            <Button
              aria-label="Create session"
              size="icon"
              disabled={createDisabled}
              onClick={onCreate}
              className="shadow-sm"
            >
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
            'group flex w-full items-center gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left text-sm font-medium transition-colors hover:border-border/70 hover:bg-background/54 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
            overviewSelected && 'border-primary/30 bg-background/80 shadow-sm',
          )}
        >
          <LayoutDashboard className="size-4 text-muted-foreground" />
          <span className="flex-1">Overview</span>
          <ShortcutReveal shortcut="O" />
        </button>
        <button
          type="button"
          onClick={onUserSkills}
          aria-current={userSkillsSelected ? 'page' : undefined}
          className={cn(
            'group mt-1 flex w-full items-center gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left text-sm font-medium transition-colors hover:border-border/70 hover:bg-background/54 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
            userSkillsSelected && 'border-primary/30 bg-background/80 shadow-sm',
          )}
        >
          <BookOpen className="size-4 text-muted-foreground" />
          <span className="flex-1">User skills</span>
          <ShortcutReveal shortcut="S" />
        </button>
        <button
          type="button"
          aria-label="Search"
          disabled={!onSearch}
          onClick={onSearch}
          className="group mt-1 flex w-full items-center gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left text-sm font-medium transition-colors hover:border-border/70 hover:bg-background/54 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          <Search className="size-4 text-muted-foreground" />
          <span className="flex-1">Search</span>
          <ShortcutReveal shortcut="K" />
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
            {sessions.map((session, index) => (
              <SessionRow
                key={session.id}
                session={session}
                shortcut={index < 5 ? String(index + 1) : undefined}
                selected={selectedSessionID === session.id}
                hasError={errorSessionIDs.has(session.id)}
                attention={sessionAttention(session, lastSeenSeqBySession)}
                pinPending={pinningSessionIDs.has(session.id)}
                onSelect={() => onSelect(session.id)}
                onPinChange={onPinChange ? (pinned) => onPinChange(session.id, pinned) : undefined}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </aside>
  )
}

function SessionRow({
  session,
  shortcut,
  selected,
  hasError,
  attention,
  pinPending,
  onSelect,
  onPinChange,
}: {
  session: Session
  shortcut?: string
  selected: boolean
  hasError: boolean
  attention: ReturnType<typeof sessionAttention>
  pinPending: boolean
  onSelect: () => void
  onPinChange?: (pinned: boolean) => void
}) {
  const title = session.title || 'Untitled session'
  const pinned = Boolean(session.pinned_at)
  const archived = Boolean(session.archived_at)

  return (
    <div
      data-session-id={session.id}
      data-pinned={pinned ? 'true' : undefined}
      className={cn(
        'session-row group flex w-full items-center rounded-md border border-transparent transition-colors hover:border-border/70 hover:bg-background/54 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring',
        selected && 'border-primary/30 bg-background/80 shadow-sm',
        archived &&
          'border-dashed border-border/80 bg-surface-muted/65 text-muted-foreground hover:border-border hover:bg-surface-muted/80',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        aria-label={archived ? `${title} archived` : title}
        className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-2 text-left focus-visible:outline-none"
      >
        <StatusBadge status={session.status} attention={attention} hasError={hasError} />
        <span
          className={cn(
            'flex min-w-0 items-center gap-1.5 text-sm font-medium',
            archived && 'text-muted-foreground line-through decoration-muted-foreground/60',
          )}
        >
          <span className="truncate">{title}</span>
        </span>
        {archived ? (
          <span className="session-row-meta flex shrink-0 items-center text-[11px] text-muted-foreground">
            <Badge
              variant="warning"
              className="min-h-5 gap-1 px-1.5 py-0 text-[10px] uppercase tracking-[0.08em]"
            >
              <Archive className="size-3" aria-hidden="true" />
              Archived
            </Badge>
          </span>
        ) : null}
      </button>
      <div className="mr-1 flex h-8 shrink-0 items-center pr-2">
        {shortcut ? (
          <ShortcutReveal shortcut={shortcut} trailingGap />
        ) : null}
        {!archived && (pinned || onPinChange) ? (
          <button
            type="button"
            aria-label={onPinChange ? (pinned ? 'Unpin session' : 'Pin session') : 'Pinned session'}
            title={onPinChange ? (pinned ? `Unpin ${title}` : `Pin ${title} to top`) : `${title} is pinned`}
            disabled={pinPending || !onPinChange}
            onClick={() => onPinChange?.(!pinned)}
            className={cn(
              'flex size-8 items-center justify-center rounded transition-all hover:bg-background/70',
              pinPending && 'opacity-40',
              pinned
                ? 'text-primary opacity-100'
                : 'text-muted-foreground opacity-100 md:pointer-events-none md:opacity-0 md:group-hover:pointer-events-auto md:group-hover:opacity-100 md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100',
            )}
          >
            <Pin className={cn('size-4', pinned && 'fill-primary/20')} />
          </button>
        ) : null}
      </div>
    </div>
  )
}

function ShortcutHint({ shortcut }: { shortcut: string }) {
  const modifier = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl '
  return (
    <kbd
      aria-hidden="true"
      className="inline-flex w-9 shrink-0 items-center justify-center rounded border border-border/70 bg-background/70 px-1 py-0.5 text-[10px] font-medium text-muted-foreground"
    >
      {modifier}{shortcut}
    </kbd>
  )
}

function ShortcutReveal({ shortcut, trailingGap = false }: { shortcut: string; trailingGap?: boolean }) {
  return (
    <span
      className={cn(
        'pointer-events-none hidden overflow-hidden opacity-0 transition-[width,margin,opacity] duration-150 md:inline-flex md:w-0 md:group-hover:w-9 md:group-hover:opacity-100 md:group-focus-within:w-9 md:group-focus-within:opacity-100',
        trailingGap && 'md:group-hover:mr-1 md:group-focus-within:mr-1',
      )}
    >
      <ShortcutHint shortcut={shortcut} />
    </span>
  )
}
