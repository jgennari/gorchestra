import { Activity, Archive, Clock3, Eraser, FileText, Folder, Gauge, Loader2, Minimize2, RefreshCw, Search } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AgentEvent, Session, WorkspaceEntry, WorkspaceFileContent, WorkspaceSearchResult } from '@/lib/api'
import { getSessionFileContent, listSessionFiles, searchSessionFiles } from '@/lib/api'
import type { StreamState } from '@/hooks/use-session-events'
import type { TokenUsageSummary } from '@/lib/events'
import { eventLabel, groupEvents, latestTokenUsage } from '@/lib/events'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Props = {
  session: Session | null
  events: AgentEvent[]
  streamState: StreamState
  streamError: string
  onClear?: () => Promise<void>
  onCompact?: () => Promise<void>
  onArchive: () => Promise<void>
  onOpenFile?: (file: WorkspaceFileContent) => void
  fileRefreshKey?: number
  clearPending?: boolean
  compactPending?: boolean
  archivePending?: boolean
}

export function RunHealthRail({
  session,
  events,
  streamState,
  streamError,
  onClear = async () => undefined,
  onCompact = async () => undefined,
  onArchive,
  onOpenFile,
  fileRefreshKey = 0,
  clearPending = false,
  compactPending = false,
  archivePending = false,
}: Props) {
  const latestEvent = events.at(-1)
  const tokenUsage = latestTokenUsage(events)
  const totalEventCount = Math.max(session?.event_count ?? 0, events.length)
  const loadedToolCount = groupEvents(events).filter(
    (group) => group.kind === 'tool-call' || group.kind === 'file-change',
  ).length
  const totalToolCount = Math.max(session?.tool_count ?? 0, loadedToolCount)
  const actionPending = clearPending || compactPending
  const codexActionDisabled =
    !session || session.agent_type !== 'codex' || session.status === 'running' || Boolean(session.archived_at) || actionPending
  const compactDisabled = codexActionDisabled || !session?.provider_session_id
  const showCodexActions = session?.agent_type === 'codex'
  const showTokenPanel = Boolean(tokenUsage) || showCodexActions

  return (
    <aside className="command-rail flex h-full w-full shrink-0 flex-col px-3 py-4">
      <div className="space-y-3">
        <RailPanel>
          <div className="flex items-center justify-between gap-2">
            <RailSectionTitle icon={Activity} label="Activity" />
            <ActiveChatDot
              active={Boolean(session)}
              running={session?.status === 'running'}
              state={streamState}
              error={streamError}
            />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Metric label="Events" value={totalEventCount} />
            <Metric label="Tools" value={totalToolCount} />
          </div>
          <div className="mt-3 border-t border-border/60 pt-3">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <Clock3 className="size-3" aria-hidden="true" />
              <span>Latest</span>
            </div>
            <div className="mt-1 flex w-full min-w-0 items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-xs font-medium">
                {latestEvent ? eventLabel(latestEvent) : 'No events'}
              </p>
              <p className="ml-auto shrink-0 text-right text-[11px] text-muted-foreground">
                {latestEvent ? formatShortDateTime(latestEvent.created_at) : 'Waiting for activity'}
              </p>
            </div>
          </div>
        </RailPanel>
      </div>

      <div className="mt-3 min-h-0 flex-1">
        <FileExplorer session={session} refreshKey={fileRefreshKey} onOpenFile={onOpenFile} />
      </div>

      <div className="mt-auto space-y-3 pt-3">
        {showTokenPanel ? (
          <RailPanel>
            <RailSectionTitle icon={Gauge} label="Tokens" />
            {tokenUsage ? <TokenUsageView usage={tokenUsage} /> : <TokenUsageEmptyState />}
            {showCodexActions ? (
              <CodexContextActions
                clearPending={clearPending}
                compactPending={compactPending}
                clearDisabled={codexActionDisabled}
                compactDisabled={compactDisabled}
                onClear={onClear}
                onCompact={onCompact}
              />
            ) : null}
          </RailPanel>
        ) : null}

        <Button
          type="button"
          variant="outline"
          className="w-full justify-start border-border/70 bg-background/40 text-muted-foreground hover:bg-background/70"
          disabled={!session || session.status === 'running' || archivePending}
          onClick={() => void onArchive()}
          aria-label="Archive selected session"
        >
          <Archive aria-hidden="true" />
          {archivePending ? 'Archiving' : 'Archive'}
        </Button>
      </div>
    </aside>
  )
}

function FileExplorer({
  session,
  refreshKey,
  onOpenFile = () => undefined,
}: {
  session: Session | null
  refreshKey: number
  onOpenFile?: (file: WorkspaceFileContent) => void
}) {
  const [currentPath, setCurrentPath] = useState('')
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WorkspaceSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [searching, setSearching] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [error, setError] = useState('')
  const sessionID = session?.id ?? ''
  const displayEntries = query.trim() ? results : entries
  const refreshing = loading || searching
  const isAtWorkspaceRoot = currentPath === ''
  const pathLabel = useMemo(() => basename(currentPath) || 'Workspace', [currentPath])

  function navigateToDirectory(path: string) {
    setCurrentPath(path)
    setQuery('')
    setError('')
  }

  useEffect(() => {
    setCurrentPath('')
    setEntries([])
    setResults([])
    setQuery('')
    setError('')
  }, [sessionID])

  useEffect(() => {
    if (!sessionID) {
      return
    }

    let cancelled = false
    async function loadFiles() {
      setLoading(true)
      setError('')
      try {
        const response = await listSessionFiles(sessionID, currentPath)
        if (cancelled) return
        setEntries(response.entries)
      } catch (loadError) {
        if (!cancelled) {
          setEntries([])
          setError(loadError instanceof Error ? loadError.message : 'Failed to load files')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadFiles()
    return () => {
      cancelled = true
    }
  }, [currentPath, refreshKey, reloadKey, sessionID])

  useEffect(() => {
    const trimmed = query.trim()
    if (!sessionID || !trimmed) {
      setResults([])
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      async function runSearch() {
        setSearching(true)
        setError('')
        try {
          const response = await searchSessionFiles(sessionID, trimmed, currentPath)
          if (!cancelled) setResults(response.results)
        } catch (searchError) {
          if (!cancelled) {
            setResults([])
            setError(searchError instanceof Error ? searchError.message : 'Failed to search files')
          }
        } finally {
          if (!cancelled) setSearching(false)
        }
      }
      void runSearch()
    }, 220)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [currentPath, query, refreshKey, reloadKey, sessionID])

  async function openEntry(entry: WorkspaceEntry) {
    if (!sessionID) {
      return
    }
    if (entry.type === 'directory') {
      navigateToDirectory(entry.path)
      return
    }

    setLoading(true)
    setError('')
    try {
      const content = await getSessionFileContent(sessionID, entry.path)
      onOpenFile(content)
    } catch (contentError) {
      setError(contentError instanceof Error ? contentError.message : 'Failed to read file')
    } finally {
      setLoading(false)
    }
  }

  return (
    <RailPanel className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2">
        <RailSectionTitle icon={Folder} label="Files" />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 border-transparent text-muted-foreground hover:bg-surface-muted/70 hover:text-foreground"
          disabled={!sessionID || refreshing}
          onClick={() => setReloadKey((value) => value + 1)}
          aria-label="Refresh files"
          title="Refresh files"
        >
          {refreshing ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
        </Button>
      </div>

      <div className="mt-2 flex items-center gap-1.5 rounded border border-border/70 bg-background/55 px-2 py-1.5">
        <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          aria-label="Search files and contents"
          value={query}
          disabled={!sessionID}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search files and contents"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
        {searching ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
      </div>

      <p className="mt-2 truncate text-[11px] text-muted-foreground" title={session?.workspace_path || undefined}>
        {session ? pathLabel : 'No session selected'}
      </p>

      <div className="mt-1 min-h-0 flex-1 overflow-auto">
        {!sessionID ? (
          <p className="py-3 text-xs text-muted-foreground">Select a session to browse files.</p>
        ) : loading && entries.length === 0 ? (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Loading files
          </div>
        ) : (
          <div className="space-y-0.5">
            {!isAtWorkspaceRoot ? (
              <>
                <button
                  type="button"
                  className="flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-surface-muted/70 hover:text-foreground"
                  onClick={() => navigateToDirectory('')}
                  aria-label="Go to workspace root"
                >
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate font-mono">.</span>
                  <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">root</span>
                </button>
                <button
                  type="button"
                  className="flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-surface-muted/70 hover:text-foreground"
                  onClick={() => navigateToDirectory(parentPath(currentPath))}
                  aria-label="Go to parent folder"
                >
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate font-mono">..</span>
                  <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
                    parent
                  </span>
                </button>
              </>
            ) : null}
            {displayEntries.map((entry) => (
              <button
                key={`${entry.type}:${entry.path}`}
                type="button"
                className="flex w-full min-w-0 items-start gap-1.5 rounded px-1.5 py-1 text-left text-xs text-foreground hover:bg-surface-muted/70"
                onClick={() => void openEntry(entry)}
              >
                {entry.type === 'directory' ? (
                  <Folder className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{entry.name}</span>
                  {query.trim() ? <SearchMatchDetail entry={entry} /> : null}
                </span>
                {entry.git_status ? <GitStatus status={entry.git_status} /> : null}
              </button>
            ))}
            {displayEntries.length === 0 ? (
              <p className="py-3 text-xs text-muted-foreground">{query.trim() ? 'No matches' : 'No files'}</p>
            ) : null}
          </div>
        )}
      </div>

      {error ? <p className="mt-2 shrink-0 text-xs text-destructive">{error}</p> : null}
    </RailPanel>
  )
}

function SearchMatchDetail({ entry }: { entry: WorkspaceEntry | WorkspaceSearchResult }) {
  const result = entry as WorkspaceSearchResult
  const linePrefix = result.match_type === 'content' && result.line_number ? `:${result.line_number}` : ''
  const detail = result.match_type === 'content' && result.line_text ? result.line_text : entry.path

  return (
    <span className="mt-0.5 block min-w-0 truncate font-mono text-[10px] leading-snug text-muted-foreground">
      {entry.path}
      {linePrefix}
      {result.match_type === 'content' && result.line_text ? ' ' : null}
      {result.match_type === 'content' && result.line_text ? detail : null}
    </span>
  )
}

function ActiveChatDot({
  active,
  running,
  state,
  error,
}: {
  active: boolean
  running: boolean
  state: StreamState
  error: string
}) {
  const label = active ? activeChatLabel(running, state, error) : 'Inactive'
  return (
    <span
      aria-label={`Active chat: ${label}`}
      role="img"
      title={`Active chat: ${label}`}
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-full',
        active ? activeChatClassName(running, state, error) : 'bg-muted-foreground',
        active && (running || state === 'loading' || state === 'reconnecting') && 'animate-pulse',
      )}
    />
  )
}

function RailPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-md border border-border/70 bg-background/46 p-3 shadow-sm', className)}>
      {children}
    </section>
  )
}

function RailSectionTitle({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
      <Icon className="size-3.5" aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded bg-surface-muted/72 px-2 py-2 text-center">
      <p className="text-lg font-semibold tabular-nums leading-none">{formatCompactCount(value)}</p>
      <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
    </div>
  )
}

function TokenUsageView({ usage }: { usage: TokenUsageSummary }) {
  const contextTokens = usage.last.totalTokens > 0 ? usage.last.totalTokens : usage.total.totalTokens
  const contextPercent = contextTokens / usage.modelContextWindow
  const cachedPercent = usage.total.inputTokens > 0 ? usage.total.cachedInputTokens / usage.total.inputTokens : 0

  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">Context</span>
        <span className={cn('text-xs font-semibold tabular-nums', tokenPressureClassName(contextPercent))}>
          {formatPercent(contextPercent)}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-muted">
        <div
          className={cn('h-full rounded-full', tokenPressureBarClassName(contextPercent))}
          style={{ width: `${Math.min(Math.max(contextPercent * 100, 0), 100)}%` }}
        />
      </div>
      <p className="mt-1 truncate text-[11px] text-muted-foreground">
        {formatTokenCount(contextTokens)} / {formatTokenCount(usage.modelContextWindow)} current
      </p>
      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {formatTokenCount(usage.total.totalTokens)} cumulative
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <TokenMetric label="Input" value={usage.total.inputTokens} />
        <TokenMetric label="Output" value={usage.total.outputTokens} />
      </div>
      <p className="mt-2 truncate text-[11px] text-muted-foreground">
        {formatTokenCount(usage.total.cachedInputTokens)} cached ({formatPercent(cachedPercent)})
      </p>
      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {formatTokenCount(usage.total.reasoningOutputTokens)} reasoning
      </p>
    </div>
  )
}

function TokenUsageEmptyState() {
  return <p className="mt-3 text-[11px] text-muted-foreground">No token usage yet</p>
}

function CodexContextActions({
  clearPending,
  compactPending,
  clearDisabled,
  compactDisabled,
  onClear,
  onCompact,
}: {
  clearPending: boolean
  compactPending: boolean
  clearDisabled: boolean
  compactDisabled: boolean
  onClear: () => Promise<void>
  onCompact: () => Promise<void>
}) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-2">
      <Button
        type="button"
        variant="outline"
        className="justify-center border-border/70 bg-background/40 px-2 text-muted-foreground hover:bg-background/70"
        disabled={clearDisabled}
        onClick={() => void onClear()}
        aria-label="Clear Codex context"
      >
        {clearPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Eraser aria-hidden="true" />}
        <span>{clearPending ? 'Clearing' : 'Clear'}</span>
      </Button>
      <Button
        type="button"
        variant="outline"
        className="justify-center border-border/70 bg-background/40 px-2 text-muted-foreground hover:bg-background/70"
        disabled={compactDisabled}
        onClick={() => void onCompact()}
        aria-label="Compact Codex context"
      >
        {compactPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Minimize2 aria-hidden="true" />}
        <span>{compactPending ? 'Compacting' : 'Compact'}</span>
      </Button>
    </div>
  )
}

function TokenMetric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-sm font-semibold tabular-nums leading-none">{formatTokenCount(value)}</p>
      <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
    </div>
  )
}

function GitStatus({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1 py-0.5 text-[9px] font-medium uppercase leading-none',
        gitStatusClassName(status),
      )}
      title={`Git: ${status}`}
    >
      {gitStatusLabel(status)}
    </span>
  )
}

function gitStatusClassName(status: string) {
  switch (status) {
    case 'modified':
      return 'bg-[hsl(var(--warning))]/18 text-amber-700 dark:text-amber-300'
    case 'added':
    case 'untracked':
      return 'bg-[hsl(var(--success))]/14 text-[hsl(var(--success))]'
    case 'deleted':
    case 'conflicted':
      return 'bg-destructive/12 text-destructive'
    default:
      return 'bg-surface-muted text-muted-foreground'
  }
}

function gitStatusLabel(status: string) {
  switch (status) {
    case 'modified':
      return 'M'
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'untracked':
      return '?'
    case 'conflicted':
      return '!'
    case 'renamed':
      return 'R'
    default:
      return status.slice(0, 1)
  }
}

function basename(path: string) {
  const parts = path.split('/').filter(Boolean)
  return parts.at(-1) ?? ''
}

function parentPath(path: string) {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

function streamStateLabel(state: StreamState, error: string) {
  if (error || state === 'disconnected') return 'Disconnected'
  if (state === 'connected') return 'Live'
  if (state === 'reconnecting') return 'Reconnecting'
  return 'Loading'
}

function activeChatLabel(running: boolean, state: StreamState, error: string) {
  if (error || state === 'disconnected') return 'Disconnected'
  if (running) return 'Running'
  return streamStateLabel(state, error)
}

function streamStateClassName(state: StreamState, error: string) {
  if (error || state === 'disconnected') return 'bg-destructive'
  if (state === 'connected') return 'bg-[hsl(var(--success))]'
  if (state === 'reconnecting') return 'bg-[hsl(var(--warning))]'
  return 'bg-muted-foreground'
}

function activeChatClassName(running: boolean, state: StreamState, error: string) {
  if (error || state === 'disconnected') return 'bg-destructive'
  if (running) return 'bg-[hsl(var(--success))]'
  return streamStateClassName(state, error)
}

function tokenPressureClassName(percent: number) {
  if (percent >= 0.9) return 'text-destructive'
  if (percent >= 0.7) return 'text-amber-700 dark:text-amber-400'
  return 'text-foreground'
}

function tokenPressureBarClassName(percent: number) {
  if (percent >= 0.9) return 'bg-destructive'
  if (percent >= 0.7) return 'bg-[hsl(var(--warning))]'
  return 'bg-primary'
}

function formatTokenCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function formatCompactCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`
}

function formatShortDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}
