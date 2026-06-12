import { ChevronDown, CircleCheck, CircleX, FileText, ListTree, Terminal, Wrench } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { AgentEvent } from '@/lib/api'
import {
  coalesceDisplayEvents,
  eventLabel,
  isErrorEvent,
  payloadError,
  payloadText,
} from '@/lib/events'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

type Props = {
  events: AgentEvent[]
}

export function EventStream({ events }: Props) {
  const displayEvents = coalesceDisplayEvents(events)
  const scrollRef = useRef<HTMLDivElement>(null)
  const shouldStickRef = useRef(true)

  useEffect(() => {
    const element = scrollRef.current
    if (!element || !shouldStickRef.current) {
      return
    }
    element.scrollTop = element.scrollHeight
  }, [displayEvents.length])

  if (displayEvents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        No events yet. Submit a prompt to start the run.
      </div>
    )
  }

  return (
    <ScrollArea
      ref={scrollRef}
      className="h-full"
      onScroll={(event) => {
        const element = event.currentTarget
        shouldStickRef.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 96
      }}
    >
      <div className="space-y-2 p-3">
        {displayEvents.map((event) => (
          <EventRow key={`${event.id}-${event.seq}`} event={event} />
        ))}
      </div>
    </ScrollArea>
  )
}

function EventRow({ event }: { event: AgentEvent }) {
  const error = isErrorEvent(event.type, event.status)
  const terminal = event.type === 'agent.run.completed' || event.type === 'agent.run.cancelled'
  const noisy = event.type.includes('tool.call') || event.type.includes('log') || event.type.includes('file.change')
  const defaultOpen = error || !noisy
  const text = payloadText(event.payload)

  return (
    <Collapsible defaultOpen={defaultOpen}>
      <article className={cn('rounded-lg border bg-card text-card-foreground shadow-sm', error && 'border-destructive/60')}>
        <div className="flex items-start gap-3 p-3">
          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border bg-background">
            <EventIcon type={event.type} error={error} terminal={terminal} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-medium">{eventLabel(event.type)}</h3>
              <Badge
                variant={
                  event.type === 'agent.run.cancelled'
                    ? 'warning'
                    : error
                      ? 'destructive'
                      : terminal
                        ? 'success'
                        : 'outline'
                }
              >
                {event.status}
              </Badge>
              <span className="text-xs text-muted-foreground">#{event.seq}</span>
            </div>
            {text ? (
              <p className={cn('mt-2 whitespace-pre-wrap break-words text-sm', isMonospace(event.type) && 'font-mono text-xs')}>
                {text}
              </p>
            ) : null}
            {error && payloadError(event.payload) ? (
              <p className="mt-2 whitespace-pre-wrap break-words text-sm text-destructive">
                {payloadError(event.payload)}
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
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </CollapsibleContent>
      </article>
    </Collapsible>
  )
}

function EventIcon({ type, error, terminal }: { type: string; error: boolean; terminal: boolean }) {
  if (error) return <CircleX className="size-4 text-destructive" />
  if (terminal) return <CircleCheck className="size-4 text-emerald-700" />
  if (type.includes('tool.call')) return <Wrench className="size-4 text-sky-700" />
  if (type.includes('file.change')) return <FileText className="size-4 text-violet-700" />
  if (type.includes('log')) return <Terminal className="size-4 text-muted-foreground" />
  return <ListTree className="size-4 text-primary" />
}

function isMonospace(type: string) {
  return type.includes('log') || type.includes('tool.call') || type.includes('file.change')
}
