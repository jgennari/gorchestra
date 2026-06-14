import { Activity, Clock3, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { AgentEvent, Session } from '@/lib/api'
import type { StreamState } from '@/hooks/use-session-events'
import { eventLabel, groupEvents } from '@/lib/events'
import { Badge } from '@/components/ui/badge'
import { StatusBadge } from '@/components/status-badge'
import { SessionTitleEditor } from '@/components/session-title-editor'
import { cn } from '@/lib/utils'

export type MessageView = 'chat' | 'debug'

type Props = {
  session: Session | null
  events: AgentEvent[]
  streamState: StreamState
  streamError: string
  notice: string
  messageView: MessageView
  onMessageViewChange: (view: MessageView) => void
  onUpdateTitle: (title: string) => Promise<void>
}

export function RunHealthRail({
  session,
  events,
  streamState,
  streamError,
  notice,
  messageView,
  onMessageViewChange,
  onUpdateTitle,
}: Props) {
  const toolCount = groupEvents(events).filter((group) => group.kind === 'tool-call' || group.kind === 'file-change').length
  const latestEvent = events.at(-1)
  const streamLabel = streamStateLabel(streamState, streamError)

  return (
    <aside className="command-rail flex h-full w-[232px] shrink-0 flex-col px-3 py-4">
      <div className="space-y-3">
        <RailPanel>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              {session ? <StatusBadge status={session.status} /> : <span className="size-2.5 rounded-full bg-muted-foreground" />}
              {session ? (
                <SessionTitleEditor title={session.title} onSave={onUpdateTitle} />
              ) : (
                <p className="truncate text-sm font-semibold">No session selected</p>
              )}
            </div>
            <div className="ml-4 mt-1 flex min-w-0 items-center gap-2">
              <Badge variant="outline" className="min-h-5 shrink-0 px-1.5 py-0 text-[10px] capitalize" aria-label={`Agent: ${session?.agent_type ?? 'none'}`}>
                {session?.agent_type ?? 'No agent'}
              </Badge>
              <span className="truncate text-[11px] text-muted-foreground">
                {session ? sessionStatusLabel(session.status) : 'Select work'}
              </span>
            </div>
          </div>
        </RailPanel>

        <MessageViewSwitch value={messageView} onChange={onMessageViewChange} />

        <RailPanel>
          <RailSectionTitle icon={Activity} label="Activity" />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Metric label="Events" value={events.length} />
            <Metric label="Tools" value={toolCount} />
          </div>
        </RailPanel>

        <RailPanel>
          <RailSectionTitle icon={Clock3} label="Latest" />
          <div className="mt-2 min-w-0">
            <p className="truncate text-xs font-medium">{latestEvent ? eventLabel(latestEvent.type) : 'No events'}</p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {latestEvent ? formatShortDateTime(latestEvent.created_at) : 'Waiting for activity'}
            </p>
          </div>
        </RailPanel>

        <RailPanel>
          <RailSectionTitle icon={Wrench} label="Connection" />
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span
              aria-hidden="true"
              className={cn(
                'size-2 rounded-full',
                streamStateClassName(streamState, streamError),
                (streamState === 'loading' || streamState === 'reconnecting') && 'animate-pulse',
              )}
            />
            <span className="truncate">{streamLabel}</span>
          </div>
          {streamError || notice ? (
            <p className={cn('mt-2 text-[11px]', streamError ? 'text-destructive' : 'text-muted-foreground')}>
              {streamError || notice}
            </p>
          ) : null}
        </RailPanel>
      </div>
    </aside>
  )
}

function MessageViewSwitch({ value, onChange }: { value: MessageView; onChange: (view: MessageView) => void }) {
  return (
    <div className="grid grid-cols-2 rounded-md border border-border/60 bg-surface-muted/72 p-1" role="tablist" aria-label="Message views">
      {(['chat', 'debug'] as const).map((view) => (
        <button
          key={view}
          type="button"
          role="tab"
          aria-selected={value === view}
          className={cn(
            'h-7 rounded px-2 text-xs font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === view ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => onChange(view)}
        >
          {view}
        </button>
      ))}
    </div>
  )
}

function RailPanel({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-md border border-border/70 bg-background/46 p-3 shadow-sm">
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
    <div className="rounded bg-surface-muted/72 px-2 py-2">
      <p className="text-lg font-semibold tabular-nums leading-none">{value}</p>
      <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
    </div>
  )
}

function sessionStatusLabel(status: Session['status']) {
  if (status === 'running') return 'Running'
  if (status === 'failed') return 'Needs attention'
  return 'Idle'
}

function streamStateLabel(state: StreamState, error: string) {
  if (error || state === 'disconnected') return 'Disconnected'
  if (state === 'connected') return 'Live'
  if (state === 'reconnecting') return 'Reconnecting'
  return 'Loading'
}

function streamStateClassName(state: StreamState, error: string) {
  if (error || state === 'disconnected') return 'bg-destructive'
  if (state === 'connected') return 'bg-[hsl(var(--success))]'
  if (state === 'reconnecting') return 'bg-[hsl(var(--warning))]'
  return 'bg-muted-foreground'
}

function formatShortDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}
