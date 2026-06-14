import { Brain, RefreshCcw } from 'lucide-react'
import type { AgentEvent, Session } from '@/lib/api'
import type { StreamState } from '@/hooks/use-session-events'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { StatusBadge } from '@/components/status-badge'
import { ChatTranscript } from '@/components/chat-transcript'
import { EventStream } from '@/components/event-stream'
import { PromptComposer } from '@/components/prompt-composer'
import { SessionTitleEditor } from '@/components/session-title-editor'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
      <section className="flex h-full w-full min-h-0 flex-col items-center justify-center overflow-hidden p-8 text-center">
        <h2 className="text-lg font-semibold">No session selected</h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          Create or select a session to monitor agent work.
        </p>
      </section>
    )
  }

  const composerDisabled = session.status === 'running'
  const disabledReason = session.status === 'running' ? 'This session is running.' : ''

  return (
    <section className="flex h-full w-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="shrink-0 border-b px-4 py-2">
        <div className="flex min-h-10 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <StatusBadge status={session.status} />
            <SessionTitleEditor title={session.title} onSave={onUpdateTitle} />
            <Badge variant="outline" className="shrink-0 capitalize" aria-label={`Agent: ${session.agent_type}`}>
              {session.agent_type}
            </Badge>
            {notice ? <span className="truncate text-sm text-muted-foreground">{notice}</span> : null}
            {streamError ? <span className="truncate text-sm text-destructive">{streamError}</span> : null}
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
            </div>
          </TooltipProvider>
        </div>
      </header>

      <Tabs defaultValue="chat" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="shrink-0 border-b px-4 py-2">
          <TabsList aria-label="Message views">
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="debug">Debug</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="chat" className="m-0 min-h-0 flex-1 overflow-hidden">
          <ChatTranscript events={events} loading={streamState === 'loading'} error={streamError} />
        </TabsContent>
        <TabsContent value="debug" className="m-0 min-h-0 flex-1 overflow-hidden">
          <EventStream events={events} loading={streamState === 'loading'} error={streamError} />
        </TabsContent>
      </Tabs>
      {session.status === 'running' ? <ThinkingIndicator /> : null}
      <Separator className="shrink-0" />
      <PromptComposer
        disabled={composerDisabled}
        disabledReason={disabledReason}
        onSubmit={onSubmitPrompt}
        onCancel={session.status === 'running' ? onCancel : undefined}
      />
    </section>
  )
}

function ThinkingIndicator() {
  return (
    <div
      role="status"
      aria-label="Thinking"
      aria-live="polite"
      className="thinking-indicator shrink-0 border-t px-4 py-2 text-sm text-muted-foreground"
    >
      <span className="inline-flex items-center gap-2">
        <Brain className="size-4" aria-hidden="true" />
        <span>Thinking</span>
      </span>
    </div>
  )
}

function ConnectionIndicator({ state, error }: { state: StreamState; error: string }) {
  const visibleLabel = streamStateLabel(state, error)
  return (
    <span
      aria-label={`Stream status: ${visibleLabel}`}
      className={cn(
        'inline-flex h-8 items-center gap-2 rounded-md border px-2 text-xs',
        error || state === 'disconnected'
          ? 'border-destructive/30 text-destructive'
          : state === 'reconnecting'
            ? 'border-amber-200 text-amber-800'
            : state === 'connected'
              ? 'border-emerald-200 text-emerald-800'
              : 'text-muted-foreground',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-2 rounded-full',
          error || state === 'disconnected'
            ? 'bg-destructive'
            : state === 'reconnecting'
              ? 'bg-amber-500'
              : state === 'connected'
                ? 'bg-emerald-500'
                : 'bg-muted-foreground',
          (state === 'loading' || state === 'reconnecting') && 'animate-pulse',
        )}
      />
      {visibleLabel}
    </span>
  )
}

function streamStateLabel(state: StreamState, error: string) {
  if (error || state === 'disconnected') return 'Disconnected'
  if (state === 'connected') return 'Live'
  if (state === 'reconnecting') return 'Reconnecting'
  return 'Loading'
}
