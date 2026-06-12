import { Ban, RefreshCcw } from 'lucide-react'
import type { AgentEvent, Session } from '@/lib/api'
import type { StreamState } from '@/hooks/use-session-events'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { StatusBadge } from '@/components/status-badge'
import { EventStream } from '@/components/event-stream'
import { PromptComposer } from '@/components/prompt-composer'
import { SessionTitleEditor } from '@/components/session-title-editor'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type Props = {
  session: Session | null
  events: AgentEvent[]
  streamState: StreamState
  streamError: string
  notice: string
  onSubmitPrompt: (content: string) => Promise<void>
  onCancel: () => Promise<void>
  onRefresh: () => void
  onUpdateTitle: (title: string) => Promise<void>
}

export function SessionDetail({
  session,
  events,
  streamState,
  streamError,
  notice,
  onSubmitPrompt,
  onCancel,
  onRefresh,
  onUpdateTitle,
}: Props) {
  if (!session) {
    return (
      <section className="flex h-full flex-col items-center justify-center p-8 text-center">
        <h2 className="text-lg font-semibold">No session selected</h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          Create or select a session to monitor agent work.
        </p>
      </section>
    )
  }

  const composerDisabled = session.status !== 'idle'
  const disabledReason =
    session.status === 'running'
      ? 'This session is running.'
      : session.status === 'idle'
        ? ''
        : `This session is ${session.status}.`

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <header className="border-b p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <SessionTitleEditor title={session.title} onSave={onUpdateTitle} />
              <StatusBadge status={session.status} />
            </div>
            <SessionMetadata session={session} lastEventAt={events.at(-1)?.created_at ?? ''} />
          </div>
          <TooltipProvider>
            <div className="flex shrink-0 items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon" onClick={onRefresh} aria-label="Refresh session">
                    <RefreshCcw />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Refresh session</TooltipContent>
              </Tooltip>
              {session.status === 'running' ? (
                <Button
                  variant="outline"
                  onClick={() => void onCancel()}
                  aria-label="Cancel running session"
                  className="border-destructive/40 text-destructive hover:bg-destructive/10"
                >
                  <Ban />
                  Cancel
                </Button>
              ) : null}
            </div>
          </TooltipProvider>
        </div>
        {notice ? <p className="mt-2 text-sm text-muted-foreground">{notice}</p> : null}
        {streamError ? <p className="mt-2 text-sm text-destructive">{streamError}</p> : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
          <h3 className="text-sm font-medium">Activity</h3>
          <ConnectionIndicator state={streamState} error={streamError} />
        </div>
        <div className="min-h-0 flex-1">
          <EventStream events={events} loading={streamState === 'loading'} error={streamError} />
        </div>
      </div>
      <Separator />
      <PromptComposer
        disabled={composerDisabled}
        disabledReason={disabledReason}
        onSubmit={onSubmitPrompt}
      />
    </section>
  )
}

function SessionMetadata({ session, lastEventAt }: { session: Session; lastEventAt: string }) {
  const rows = [
    ['Agent', session.agent_type],
    ['Created', formatDateTime(session.created_at)],
    ['Updated', formatDateTime(session.updated_at)],
    ['Last event', lastEventAt ? formatDateTime(lastEventAt) : 'No events'],
  ]
  if (session.completed_at) {
    rows.push(['Terminal', formatDateTime(session.completed_at)])
  }

  return (
    <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-5">
      {rows.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="inline font-medium text-foreground">{label}: </dt>
          <dd className="inline break-words">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function ConnectionIndicator({ state, error }: { state: StreamState; error: string }) {
  const label = error ? 'stream error' : state
  const visibleLabel = label === 'connected' ? 'live' : label
  return (
    <span
      className={cn(
        'inline-flex h-8 items-center rounded-md border px-2 text-xs',
        error || state === 'disconnected'
          ? 'border-destructive/40 text-destructive'
          : state === 'reconnecting'
            ? 'border-amber-200 bg-amber-50 text-amber-800'
            : 'text-muted-foreground',
      )}
    >
      {visibleLabel}
    </span>
  )
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}
