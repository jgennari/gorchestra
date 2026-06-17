import { Archive, ListFilter, LoaderCircle, Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentType, Session, SessionStatus } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { StatusBadge } from '@/components/status-badge'
import { ThemeToggle } from '@/components/theme-toggle'
import type { ResolvedTheme, ThemePreference } from '@/hooks/use-theme'
import { sessionAttention } from '@/lib/session-attention'
import { cn } from '@/lib/utils'

export type SessionListStatusFilter = 'all' | SessionStatus | 'pending-input'
export type SessionListAgentFilter = 'all' | AgentType

export type SessionListFilters = {
  status: SessionListStatusFilter
  agent: SessionListAgentFilter
  attentionOnly: boolean
  includeArchived: boolean
}

export const defaultSessionListFilters: SessionListFilters = {
  status: 'all',
  agent: 'all',
  attentionOnly: false,
  includeArchived: false,
}

type Props = {
  sessions: Session[]
  selectedSessionID: string | null
  lastSeenSeqBySession?: Record<string, number>
  loading?: boolean
  query: string
  onQueryChange: (query: string) => void
  filters: SessionListFilters
  onFiltersChange: (filters: SessionListFilters) => void
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
  loading = false,
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  onSelect,
  onCreate,
  themePreference,
  resolvedTheme,
  onThemeToggle,
  variant = 'full',
}: Props) {
  const [filtersOpen, setFiltersOpen] = useState(false)
  const filtersRef = useRef<HTMLDivElement | null>(null)
  const visibleSessions = useMemo(
    () => filterSessions(sessions, query, filters, lastSeenSeqBySession),
    [filters, lastSeenSeqBySession, query, sessions],
  )
  const showHeader = variant === 'full'
  const activeFilterCount = countActiveFilters(filters)
  const hasSearch = query.trim().length > 0
  const hasFilteredEmptyState = hasSearch || activeFilterCount > 0

  useEffect(() => {
    if (!filtersOpen) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      if (filtersRef.current?.contains(event.target as Node)) {
        return
      }
      setFiltersOpen(false)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setFiltersOpen(false)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [filtersOpen])

  function updateFilters(nextFilters: Partial<SessionListFilters>) {
    onFiltersChange({ ...filters, ...nextFilters })
  }

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
          <img src="/icon.svg" alt="Gorchestra" className="sidebar-logo-mark h-9 w-9 shrink-0" />
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
        <div ref={filtersRef} className="relative flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              aria-label="Search sessions"
              placeholder="Search sessions..."
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              className="h-9 bg-background/60 pl-8"
            />
          </div>
          <div className="shrink-0">
            <Button
              type="button"
              size="icon"
              variant={activeFilterCount > 0 ? 'secondary' : 'outline'}
              aria-label={activeFilterCount > 0 ? `Session filters, ${activeFilterCount} active` : 'Session filters'}
              aria-haspopup="dialog"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((current) => !current)}
              className="relative"
            >
              {loading ? <LoaderCircle className="animate-spin" /> : <ListFilter />}
              {activeFilterCount > 0 ? (
                <span className="absolute -right-1 -top-1 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
                  {activeFilterCount}
                </span>
              ) : null}
            </Button>
            {filtersOpen ? (
              <div
                role="dialog"
                aria-label="Session filters"
                className="absolute right-0 top-11 z-20 w-[min(18rem,calc(100vw-2rem),calc(100%-0.5rem))] rounded-md border border-border/80 bg-background/98 p-3 shadow-xl"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">Filters</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={activeFilterCount === 0}
                    onClick={() => onFiltersChange(defaultSessionListFilters)}
                  >
                    Clear
                  </Button>
                </div>

                <div className="mt-3 space-y-3">
                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span>Show archived</span>
                    <input
                      type="checkbox"
                      checked={filters.includeArchived}
                      onChange={(event) => updateFilters({ includeArchived: event.currentTarget.checked })}
                      className="h-4 w-4 rounded border-border text-primary focus:ring-2 focus:ring-ring"
                    />
                  </label>

                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span>Attention only</span>
                    <input
                      type="checkbox"
                      checked={filters.attentionOnly}
                      onChange={(event) => updateFilters({ attentionOnly: event.currentTarget.checked })}
                      className="h-4 w-4 rounded border-border text-primary focus:ring-2 focus:ring-ring"
                    />
                  </label>

                  <div>
                    <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Status</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {statusFilterOptions.map((option) => (
                        <Button
                          key={option.value}
                          type="button"
                          size="sm"
                          variant={filters.status === option.value ? 'secondary' : 'outline'}
                          onClick={() => updateFilters({ status: option.value })}
                        >
                          {option.label}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Agent</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {agentFilterOptions.map((option) => (
                        <Button
                          key={option.value}
                          type="button"
                          size="sm"
                          variant={filters.agent === option.value ? 'secondary' : 'outline'}
                          onClick={() => updateFilters({ agent: option.value })}
                        >
                          {option.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1">
        {loading && sessions.length === 0 ? (
          <div className="flex h-full min-h-40 items-center justify-center p-4 text-sm text-muted-foreground">
            Loading sessions...
          </div>
        ) : visibleSessions.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            {sessions.length === 0 ? 'No sessions yet.' : hasFilteredEmptyState ? 'No sessions match your filters.' : 'No sessions yet.'}
          </div>
        ) : (
          <div className="session-list-rows space-y-1.5 p-2.5">
            {visibleSessions.map((session) => (
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

const statusFilterOptions: Array<{ value: SessionListStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'pending-input', label: 'Needs input' },
  { value: 'failed', label: 'Failed' },
  { value: 'idle', label: 'Idle' },
]

const agentFilterOptions: Array<{ value: SessionListAgentFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude' },
  { value: 'fake', label: 'Fake' },
]

function countActiveFilters(filters: SessionListFilters) {
  let count = 0
  if (filters.includeArchived) count += 1
  if (filters.attentionOnly) count += 1
  if (filters.status !== defaultSessionListFilters.status) count += 1
  if (filters.agent !== defaultSessionListFilters.agent) count += 1
  return count
}

function filterSessions(
  sessions: Session[],
  query: string,
  filters: SessionListFilters,
  lastSeenSeqBySession: Record<string, number>,
) {
  const normalizedQuery = query.trim().toLowerCase()
  return sessions.filter((session) => {
    if (!filters.includeArchived && session.archived_at) {
      return false
    }
    if (filters.status === 'pending-input' && !session.pending_input) {
      return false
    }
    if (
      filters.status !== 'all' &&
      filters.status !== 'pending-input' &&
      session.status !== filters.status
    ) {
      return false
    }
    if (filters.agent !== 'all' && session.agent_type !== filters.agent) {
      return false
    }
    if (filters.attentionOnly && sessionAttention(session, lastSeenSeqBySession) === null) {
      return false
    }
    if (normalizedQuery && !sessionSearchText(session).includes(normalizedQuery)) {
      return false
    }
    return true
  })
}

function sessionSearchText(session: Session) {
  return [
    session.id,
    session.title,
    session.agent_type,
    session.status,
    session.workspace_path,
    session.archived_at ? 'archived' : 'active',
    session.pending_input ? 'pending input' : '',
  ].join(' ').toLowerCase()
}

function formatShortTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}
