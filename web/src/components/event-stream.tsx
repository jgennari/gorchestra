import {
  ArrowDown,
  ChevronDown,
  CircleCheck,
  CircleX,
  FileText,
  ListTree,
  Terminal,
  Wrench,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent } from '@/lib/api'
import type { EventGroup, EventGroupKind } from '@/lib/events'
import { groupEvents } from '@/lib/events'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

type Props = {
  events: AgentEvent[]
  loading?: boolean
  error?: string
}

export function EventStream({ events, loading = false, error = '' }: Props) {
  const groups = useMemo(() => groupEvents(events), [events])
  const scrollRef = useRef<HTMLDivElement>(null)
  const followingRef = useRef(true)
  const lastStartSeqRef = useRef(0)
  const lastEndSeqRef = useRef(0)
  const lastScrollHeightRef = useRef(0)
  const [showJump, setShowJump] = useState(false)

  const scrollToLatest = useCallback(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }
    element.scrollTop = element.scrollHeight
    followingRef.current = true
    setShowJump(false)
  }, [])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }
    const activeElement = element

    const nextStartSeq = groups[0]?.startSeq ?? 0
    const nextEndSeq = groups.at(-1)?.endSeq ?? 0
    const olderHistoryInserted =
      lastStartSeqRef.current > 0 && nextStartSeq > 0 && nextStartSeq < lastStartSeqRef.current
    const hasNewEvents = nextEndSeq > lastEndSeqRef.current

    function rememberScrollState() {
      lastStartSeqRef.current = nextStartSeq
      lastEndSeqRef.current = nextEndSeq
      lastScrollHeightRef.current = activeElement.scrollHeight
    }

    if (followingRef.current) {
      activeElement.scrollTop = activeElement.scrollHeight
      setShowJump(false)
      rememberScrollState()
      return
    }

    if (olderHistoryInserted && lastScrollHeightRef.current > 0) {
      const heightDelta = activeElement.scrollHeight - lastScrollHeightRef.current
      if (heightDelta > 0) {
        activeElement.scrollTop += heightDelta
      }
    }

    if (hasNewEvents) {
      setShowJump(true)
    }

    rememberScrollState()
  }, [groups])

  if (error && groups.length === 0) {
    return (
      <div role="alert" className="flex h-full items-center justify-center p-8 text-center text-sm text-destructive">
        Failed to load event history: {error}
      </div>
    )
  }

  if (loading && groups.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        Loading session history...
      </div>
    )
  }

  if (groups.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        No events yet. Submit a prompt to start the run.
      </div>
    )
  }

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <ScrollArea
        ref={scrollRef}
        className="h-full min-h-0"
        role="log"
        aria-label="Session events"
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={(event) => {
          const nearBottom = isNearBottom(event.currentTarget)
          followingRef.current = nearBottom
          if (nearBottom) {
            setShowJump(false)
          }
        }}
      >
        <div className="space-y-2 p-3 pb-16">
          {groups.map((group) => (
            <EventGroupRow key={group.id} group={group} />
          ))}
        </div>
      </ScrollArea>

      {showJump ? (
        <Button
          type="button"
          size="sm"
          className="absolute bottom-4 right-4 shadow-md"
          onClick={scrollToLatest}
          aria-label="Jump to latest event"
        >
          <ArrowDown />
          Jump to latest
        </Button>
      ) : null}
    </div>
  )
}

function EventGroupRow({ group }: { group: EventGroup }) {
  const error = group.kind === 'error' || group.events.some((event) => event.status === 'failed')
  const rawPayload = group.events.length === 1 ? group.events[0].payload : group.events.map(rawEventSummary)
  const showText = Boolean(group.text && group.text !== group.error)

  return (
    <Collapsible defaultOpen={group.defaultOpen}>
      <article
        className={cn(
          'rounded-lg border bg-card text-card-foreground shadow-sm',
          error && 'border-destructive/60',
          group.terminal && !error && 'border-emerald-300',
        )}
      >
        <div className="flex items-start gap-3 p-3">
          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border bg-background">
            <EventIcon kind={group.kind} error={error} terminal={group.terminal} />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-medium">{group.label}</h3>
              <Badge variant={badgeVariant(group, error)}>{group.status}</Badge>
              <span className="text-xs text-muted-foreground">{sequenceLabel(group)}</span>
              {group.events.length > 1 ? (
                <span className="text-xs text-muted-foreground">{group.events.length} events</span>
              ) : null}
            </div>

            {group.paths.length > 0 ? (
              <ul className="mt-2 space-y-1 text-sm">
                {group.paths.map((path) => (
                  <li key={path} className="break-all font-mono text-xs text-muted-foreground">
                    {path}
                  </li>
                ))}
              </ul>
            ) : showText ? (
              <p className={cn('mt-2 whitespace-pre-wrap break-words text-sm', isMonospace(group.kind) && 'font-mono text-xs')}>
                {group.text}
              </p>
            ) : null}

            {group.error ? (
              <p className="mt-2 whitespace-pre-wrap break-words text-sm text-destructive">
                {group.error}
              </p>
            ) : null}
          </div>

          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Toggle event details">
              <ChevronDown />
            </Button>
          </CollapsibleTrigger>
        </div>

        <CollapsibleContent>
          <pre className="max-h-64 overflow-auto border-t bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
            {JSON.stringify(rawPayload, null, 2)}
          </pre>
        </CollapsibleContent>
      </article>
    </Collapsible>
  )
}

function EventIcon({ kind, error, terminal }: { kind: EventGroupKind; error: boolean; terminal: boolean }) {
  if (error) return <CircleX className="size-4 text-destructive" />
  if (terminal) return <CircleCheck className="size-4 text-emerald-700" />
  if (kind === 'tool-call') return <Wrench className="size-4 text-sky-700" />
  if (kind === 'file-change') return <FileText className="size-4 text-violet-700" />
  if (kind === 'log') return <Terminal className="size-4 text-muted-foreground" />
  return <ListTree className="size-4 text-primary" />
}

function badgeVariant(group: EventGroup, error: boolean) {
  if (group.events.some((event) => event.type === 'agent.run.cancelled')) return 'warning'
  if (error) return 'destructive'
  if (group.terminal) return 'success'
  return 'outline'
}

function sequenceLabel(group: EventGroup) {
  return group.startSeq === group.endSeq ? `#${group.startSeq}` : `#${group.startSeq}-${group.endSeq}`
}

function rawEventSummary(event: AgentEvent) {
  return {
    seq: event.seq,
    type: event.type,
    status: event.status,
    payload: event.payload,
    created_at: event.created_at,
  }
}

function isMonospace(kind: EventGroupKind) {
  return kind === 'log' || kind === 'tool-call' || kind === 'file-change'
}

function isNearBottom(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 96
}
