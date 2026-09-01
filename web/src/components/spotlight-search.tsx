import {
  Bot,
  FileCode2,
  FileText,
  FolderClock,
  Loader2,
  MessageSquare,
  Search,
  TerminalSquare,
  UserRound,
} from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { searchSpotlight, type SpotlightSearchResult } from '@/lib/api'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

type ResultFilter = 'all' | SpotlightSearchResult['kind']

const resultKindOrder: SpotlightSearchResult['kind'][] = [
  'session',
  'user_message',
  'agent_message',
  'tool_call',
  'agent_instruction',
  'file',
]

export function SpotlightSearch({
  open,
  sessionID,
  onOpenChange,
  onSelect,
}: {
  open: boolean
  sessionID: string | null
  onOpenChange: (open: boolean) => void
  onSelect: (result: SpotlightSearchResult) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SpotlightSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [settled, setSettled] = useState(false)
  const [error, setError] = useState('')
  const [localError, setLocalError] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setResults([])
      setLoading(false)
      setSettled(false)
      setError('')
      setLocalError('')
      setActiveIndex(0)
      setResultFilter('all')
    }
  }, [open])

  useEffect(() => {
    const trimmed = query.trim()
    if (!open || !trimmed) {
      setResults([])
      setLoading(false)
      setSettled(false)
      setError('')
      setLocalError('')
      setActiveIndex(0)
      setResultFilter('all')
      return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError('')
      void searchSpotlight(trimmed, sessionID, controller.signal)
        .then((response) => {
          if (controller.signal.aborted) return
          setResults(response.results)
          setLocalError(response.local_error ?? '')
          setSettled(true)
          setActiveIndex(0)
          setResultFilter((current) =>
            current === 'all' || response.results.some((result) => result.kind === current) ? current : 'all',
          )
        })
        .catch((searchError: unknown) => {
          if (controller.signal.aborted) return
          setResults([])
          setLocalError('')
          setError(searchError instanceof Error ? searchError.message : 'Search failed')
          setSettled(true)
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, 180)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [open, query, sessionID])

  useEffect(() => {
    const result = resultRefs.current[activeIndex]
    if (typeof result?.scrollIntoView === 'function') result.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  function choose(result: SpotlightSearchResult) {
    onSelect(result)
    onOpenChange(false)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' && visibleResults.length > 0) {
      event.preventDefault()
      setActiveIndex((current) => (current + 1) % visibleResults.length)
    } else if (event.key === 'ArrowUp' && visibleResults.length > 0) {
      event.preventDefault()
      setActiveIndex((current) => (current - 1 + visibleResults.length) % visibleResults.length)
    } else if (event.key === 'Enter' && visibleResults[activeIndex]) {
      event.preventDefault()
      choose(visibleResults[activeIndex])
    }
  }

  const expanded = settled && query.trim().length > 0
  const counts = results.reduce<Partial<Record<SpotlightSearchResult['kind'], number>>>((current, result) => {
    current[result.kind] = (current[result.kind] ?? 0) + 1
    return current
  }, {})
  const availableKinds = resultKindOrder.filter((kind) => counts[kind])
  const visibleResults = resultFilter === 'all' ? results : results.filter((result) => result.kind === resultFilter)

  function applyResultFilter(filter: ResultFilter) {
    setResultFilter(filter)
    setActiveIndex(0)
    searchInputRef.current?.focus()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showClose={false}
        overlayClassName="bg-black/20 backdrop-blur-[3px]"
        aria-describedby={undefined}
        className={cn(
          'command-chat-header top-[18vh] block max-w-2xl -translate-y-0 gap-0 overflow-hidden border-border/60 p-0 shadow-[0_24px_80px_hsl(220_40%_2%/0.38)] transition-[max-height] duration-200',
          expanded ? 'max-h-[70vh]' : 'max-h-16',
        )}
      >
        <DialogTitle className="sr-only">Search Gorchestra</DialogTitle>
        <div className="flex h-16 items-center gap-3 px-4">
          <Search className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={searchInputRef}
            autoFocus
            aria-label="Search Gorchestra"
            aria-controls="spotlight-search-results"
            aria-activedescendant={visibleResults[activeIndex] ? `spotlight-result-${activeIndex}` : undefined}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search sessions, history, tools, and current files…"
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
          />
          {loading ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Searching" /> : null}
          <kbd className="rounded border border-border/70 bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            Esc
          </kbd>
        </div>

        {expanded ? (
          <div className="max-h-[calc(70vh-4rem)] border-t border-border/70">
            {!error && availableKinds.length > 0 ? (
              <div
                role="group"
                aria-label="Filter search results"
                className="subtle-scrollbar flex gap-1.5 overflow-x-auto border-b border-border/60 px-3 py-2.5"
              >
                <ResultFilterPill
                  label="All"
                  count={results.length}
                  selected={resultFilter === 'all'}
                  onClick={() => applyResultFilter('all')}
                />
                {availableKinds.map((kind) => (
                  <ResultFilterPill
                    key={kind}
                    label={resultKindFilterLabel(kind)}
                    count={counts[kind] ?? 0}
                    selected={resultFilter === kind}
                    onClick={() => applyResultFilter(kind)}
                  />
                ))}
              </div>
            ) : null}
            <div
              id="spotlight-search-results"
              role="listbox"
              className="subtle-scrollbar max-h-[calc(70vh-7.25rem)] overflow-y-auto p-2"
            >
            {error ? (
              <p role="alert" className="px-3 py-6 text-center text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {!error && results.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">No results for “{query.trim()}”</p>
            ) : null}
            {!error
              ? visibleResults.map((result, index) => {
                  const detail =
                    result.scope === 'local'
                      ? `Current session · ${result.path ?? result.workspace_path ?? ''}`
                      : `${result.session_title || 'Untitled session'}${result.archived ? ' · Archived' : ''}`
                  return (
                    <button
                      ref={(element) => {
                        resultRefs.current[index] = element
                      }}
                      id={`spotlight-result-${index}`}
                      key={result.id}
                      role="option"
                      aria-selected={index === activeIndex}
                      type="button"
                      onPointerMove={() => setActiveIndex(index)}
                      onClick={() => choose(result)}
                      className={cn(
                        'flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                        index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                      )}
                    >
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/75 text-muted-foreground">
                        <ResultIcon result={result} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium">{result.title}</span>
                          <span className="shrink-0 rounded border border-border/70 bg-background/65 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                            {resultKindLabel(result.kind)}
                          </span>
                        </span>
                        {result.snippet && result.snippet !== result.title ? (
                          <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">
                            {result.snippet}
                          </span>
                        ) : null}
                        <span className="mt-1 block truncate text-[11px] text-muted-foreground/80">
                          {detail}
                          {formatResultDate(result.created_at)}
                        </span>
                      </span>
                    </button>
                  )
                })
              : null}
            {localError ? (
              <p className="px-3 py-2 text-xs text-amber-700 dark:text-amber-300">Local files: {localError}</p>
            ) : null}
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function ResultFilterPill({
  label,
  count,
  selected,
  onClick,
}: {
  label: string
  count: number
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={`${label} ${count}`}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected
          ? 'border-primary/35 bg-primary/15 text-foreground'
          : 'border-border/65 bg-background/45 text-muted-foreground hover:bg-background/70 hover:text-foreground',
      )}
    >
      <span>{label}</span>
      <span className="tabular-nums text-[10px] opacity-70">{count}</span>
    </button>
  )
}

function ResultIcon({ result }: { result: SpotlightSearchResult }) {
  const className = 'size-4'
  switch (result.kind) {
    case 'session':
      return <FolderClock className={className} />
    case 'user_message':
      return <UserRound className={className} />
    case 'agent_message':
      return <MessageSquare className={className} />
    case 'tool_call':
      return <TerminalSquare className={className} />
    case 'agent_instruction':
      return <FileCode2 className={className} />
    case 'file':
      return <FileText className={className} />
    default:
      return <Bot className={className} />
  }
}

function resultKindLabel(kind: SpotlightSearchResult['kind']) {
  switch (kind) {
    case 'user_message':
      return 'User message'
    case 'agent_message':
      return 'Agent text'
    case 'tool_call':
      return 'Tool call'
    case 'agent_instruction':
      return 'Agent instruction'
    case 'session':
      return 'Session'
    case 'file':
      return 'File'
  }
}

function resultKindFilterLabel(kind: SpotlightSearchResult['kind']) {
  switch (kind) {
    case 'session':
      return 'Sessions'
    case 'user_message':
      return 'User'
    case 'agent_message':
      return 'Agent'
    case 'tool_call':
      return 'Tools'
    case 'agent_instruction':
      return 'Instructions'
    case 'file':
      return 'Files'
  }
}

function formatResultDate(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return ` · ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)}`
}
