import { ArrowDownToLine, ChevronDown, ChevronUp, Loader2, Map } from 'lucide-react'
import { useMemo } from 'react'
import type { AgentEvent } from '@/lib/api'
import type { ChatTimelineItem, TranscriptSequenceRange } from '@/lib/events'
import { buildChatTimeline } from '@/lib/events'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type ConversationMapItem = {
  id: string
  kind: 'user' | 'assistant' | 'plan' | 'action' | 'error'
  startSeq: number
  endSeq: number
  label: string
  excerpt: string
  createdAt: string
  weight: number
  tools: Array<{ id: string; kind: 'tool-call' | 'file-change'; startSeq: number; endSeq: number; label: string }>
}

type Props = {
  events: AgentEvent[]
  hasOlderEvents: boolean
  hasNewerEvents: boolean
  loadingOlderEvents: boolean
  loadingNewerEvents: boolean
  visibleRange: TranscriptSequenceRange | null
  focusedSeq: number
  onLoadOlderEvents?: () => Promise<void> | void
  onLoadNewerEvents?: () => Promise<void> | void
  onJumpToLatest?: () => Promise<void> | void
  onSelectSeq?: (seq: number) => void
}

export function ConversationMap({
  events,
  hasOlderEvents,
  hasNewerEvents,
  loadingOlderEvents,
  loadingNewerEvents,
  visibleRange,
  focusedSeq,
  onLoadOlderEvents,
  onLoadNewerEvents,
  onJumpToLatest,
  onSelectSeq,
}: Props) {
  const items = useMemo(() => conversationMapItems(events), [events])

  return (
    <section className="flex h-full min-h-0 flex-col rounded-md border border-border/70 bg-background/46 p-3 shadow-sm">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <Map className="size-3.5" aria-hidden="true" />
          <span>Conversation map</span>
        </div>
        <MapLegend />
      </div>

      <div className="mt-2 flex shrink-0 items-center justify-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          disabled={!hasOlderEvents || loadingOlderEvents || !onLoadOlderEvents}
          aria-label="Load earlier conversation turns"
          title="Load earlier conversation turns"
          onClick={() => void onLoadOlderEvents?.()}
        >
          {loadingOlderEvents ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
        </Button>
        <span className="text-[10px] text-muted-foreground">Earlier</span>
      </div>

      <TooltipProvider delayDuration={180}>
        <nav
          aria-label="Conversation map"
          className="subtle-scrollbar my-2 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto rounded border border-border/55 bg-[hsl(var(--foreground)/0.025)] p-1.5"
        >
          {items.length === 0 ? (
            <div className="flex min-h-32 flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground">
              No conversation yet.
            </div>
          ) : (
            items.map((item) => (
              <MapSegment
                key={item.id}
                item={item}
                visible={rangesOverlap(item, visibleRange)}
                focused={focusedSeq >= item.startSeq && focusedSeq <= item.endSeq}
                onSelect={() => onSelectSeq?.(item.startSeq)}
              />
            ))
          )}
        </nav>
      </TooltipProvider>

      <div className="flex shrink-0 items-center justify-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          disabled={!hasNewerEvents || loadingNewerEvents || !onLoadNewerEvents}
          aria-label="Load newer conversation turns"
          title="Load newer conversation turns"
          onClick={() => void onLoadNewerEvents?.()}
        >
          {loadingNewerEvents ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          disabled={!hasNewerEvents || !onJumpToLatest}
          aria-label="Jump conversation map to latest"
          title="Jump to latest"
          onClick={() => void onJumpToLatest?.()}
        >
          <ArrowDownToLine aria-hidden="true" />
        </Button>
      </div>
    </section>
  )
}

function MapSegment({
  item,
  visible,
  focused,
  onSelect,
}: {
  item: ConversationMapItem
  visible: boolean
  focused: boolean
  onSelect: () => void
}) {
  const sequence = item.startSeq === item.endSeq ? `#${item.startSeq}` : `#${item.startSeq}–${item.endSeq}`
  const detail = [item.label, sequence, formatMapTime(item.createdAt), item.excerpt].filter(Boolean).join(' · ')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'group relative w-full min-h-1.5 shrink-0 overflow-hidden rounded-[3px] border text-left outline-none transition-[background-color,filter,box-shadow] hover:brightness-105 focus-visible:ring-2 focus-visible:ring-ring',
            mapSegmentClassName(item.kind),
            visible && mapVisibleSegmentClassName(item.kind),
            focused && 'shadow-[0_0_0_2px_hsl(var(--primary)/0.45)]',
          )}
          style={{
            flexGrow: item.weight,
            height: `${Math.min(18, Math.max(6, item.weight * 3))}px`,
            maxHeight: '2.5rem',
          }}
          aria-label={`Open ${detail}`}
          onClick={onSelect}
        >
          {item.tools.map((tool) => {
            const span = Math.max(1, item.endSeq - item.startSeq + 1)
            const offset = Math.min(96, Math.max(2, ((tool.startSeq - item.startSeq) / span) * 100))
            return (
              <span
                key={tool.id}
                aria-hidden="true"
                className={cn(
                  'absolute bottom-0 top-0 w-0.5 bg-foreground/25',
                  tool.kind === 'file-change' && 'w-1 bg-[hsl(var(--warning)/0.42)]',
                )}
                style={{ left: `${offset}%` }}
              />
            )
          })}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-64">
        <p className="font-medium">{item.label} · {sequence}</p>
        {item.excerpt ? <p className="mt-0.5 line-clamp-2 text-muted-foreground">{item.excerpt}</p> : null}
      </TooltipContent>
    </Tooltip>
  )
}

function MapLegend() {
  return (
    <div aria-label="Conversation map legend" className="flex items-center gap-1.5" title="User · Agent · Tools/files">
      <span className="size-2 rounded-sm bg-primary/30" aria-hidden="true" />
      <span className="size-2 rounded-sm bg-[hsl(var(--foreground)/0.16)]" aria-hidden="true" />
      <span className="h-2 w-0.5 bg-[hsl(var(--warning)/0.42)]" aria-hidden="true" />
    </div>
  )
}

function conversationMapItems(events: AgentEvent[]): ConversationMapItem[] {
  return buildChatTimeline(events, false).map(conversationMapItem)
}

function conversationMapItem(item: ChatTimelineItem): ConversationMapItem {
  const sequenceWeight = Math.min(6, 1 + Math.log2(Math.max(1, item.endSeq - item.startSeq + 1)))
  if (item.kind === 'message') {
    const plan = item.message.variant === 'plan'
    return {
      id: item.id,
      kind: plan ? 'plan' : item.message.role,
      startSeq: item.startSeq,
      endSeq: item.endSeq,
      label: plan ? 'Agent plan' : item.message.role === 'user' ? 'User message' : 'Agent response',
      excerpt: compactExcerpt(item.message.text),
      createdAt: item.message.createdAt,
      weight: Math.max(sequenceWeight, item.message.tools.length > 0 ? 2 : 1),
      tools: item.message.tools.map((tool) => ({
        id: tool.id,
        kind: tool.kind,
        startSeq: tool.startSeq,
        endSeq: tool.endSeq,
        label: tool.label,
      })),
    }
  }
  if (item.kind === 'action') {
    return {
      id: item.id,
      kind: 'action',
      startSeq: item.startSeq,
      endSeq: item.endSeq,
      label: item.action.label || 'Session action',
      excerpt: compactExcerpt(item.action.detail),
      createdAt: item.action.createdAt,
      weight: sequenceWeight,
      tools: [],
    }
  }
  if (item.kind === 'error') {
    return {
      id: item.id,
      kind: 'error',
      startSeq: item.startSeq,
      endSeq: item.endSeq,
      label: item.error.label || 'Run error',
      excerpt: compactExcerpt(item.error.error),
      createdAt: item.error.createdAt,
      weight: sequenceWeight,
      tools: [],
    }
  }
  return {
    id: item.id,
    kind: 'action',
    startSeq: item.startSeq,
    endSeq: item.endSeq,
    label: item.event.label,
    excerpt: compactExcerpt(item.event.text || item.event.error),
    createdAt: item.event.createdAt,
    weight: sequenceWeight,
    tools: [],
  }
}

function mapSegmentClassName(kind: ConversationMapItem['kind']) {
  switch (kind) {
    case 'user':
      return 'border-primary/18 bg-primary/30'
    case 'assistant':
      return 'border-foreground/10 bg-[hsl(var(--foreground)/0.15)]'
    case 'plan':
      return 'border-violet-400/18 bg-violet-400/30'
    case 'error':
      return 'border-destructive/22 bg-destructive/32'
    case 'action':
      return 'border-border/50 bg-muted-foreground/20'
  }
}

function mapVisibleSegmentClassName(kind: ConversationMapItem['kind']) {
  switch (kind) {
    case 'user':
      return 'bg-primary/42'
    case 'assistant':
      return 'bg-[hsl(var(--foreground)/0.23)]'
    case 'plan':
      return 'bg-violet-400/42'
    case 'error':
      return 'bg-destructive/44'
    case 'action':
      return 'bg-muted-foreground/28'
  }
}

function rangesOverlap(item: ConversationMapItem, range: TranscriptSequenceRange | null) {
  return Boolean(range && item.endSeq >= range.firstSeq && item.startSeq <= range.lastSeq)
}

function compactExcerpt(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120)
}

function formatMapTime(value: string) {
  if (!value) return ''
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
