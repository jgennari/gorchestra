import { Ban, RefreshCcw } from 'lucide-react'
import type { AgentEvent, Session } from '@/lib/api'
import type { StreamState } from '@/hooks/use-session-events'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { StatusBadge } from '@/components/status-badge'
import { EventStream } from '@/components/event-stream'
import { PromptComposer } from '@/components/prompt-composer'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

type Props = {
  session: Session | null
  events: AgentEvent[]
  streamState: StreamState
  streamError: string
  notice: string
  onSubmitPrompt: (content: string) => Promise<void>
  onCancel: () => Promise<void>
  onRefresh: () => void
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
              <h2 className="truncate text-lg font-semibold">{session.title || 'Untitled session'}</h2>
              <StatusBadge status={session.status} />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {session.agent_type} · updated {formatDateTime(session.updated_at)}
            </p>
          </div>
          <TooltipProvider>
            <div className="flex shrink-0 items-center gap-2">
              <ConnectionIndicator state={streamState} error={streamError} />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon" onClick={onRefresh} aria-label="Refresh session">
                    <RefreshCcw />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Refresh session</TooltipContent>
              </Tooltip>
              {session.status === 'running' ? (
                <Button variant="destructive" onClick={() => void onCancel()}>
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

      <div className="min-h-0 flex-1">
        <EventStream events={events} />
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

function ConnectionIndicator({ state, error }: { state: StreamState; error: string }) {
  const label = error ? 'stream error' : state
  return (
    <span className="inline-flex h-8 items-center rounded-md border px-2 text-xs text-muted-foreground">
      {label}
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
