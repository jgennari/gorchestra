import { RefreshCcw } from 'lucide-react'
import type { AgentEvent, Session, SubmitAgentOptions } from '@/lib/api'
import type { StreamState } from '@/hooks/use-session-events'
import type { MessageView } from '@/components/run-health-rail'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
  messageView: MessageView
  onMessageViewChange: (view: MessageView) => void
  onSubmitPrompt: (content: string, agentOptions?: SubmitAgentOptions) => Promise<void>
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
  messageView,
  onMessageViewChange,
  onSubmitPrompt,
  onCancel,
  onRefresh,
  onUpdateTitle,
}: Props) {
  if (!session) {
    return (
      <section className="command-workspace flex h-full w-full min-h-0 flex-col items-center justify-center overflow-hidden p-8 text-center">
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
    <section className="relative flex h-full w-full min-h-0 flex-col overflow-hidden bg-transparent">
      <header className="shrink-0 border-b border-border/70 bg-background/62 px-4 py-2 backdrop-blur lg:hidden">
        <div className="flex min-h-10 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <StatusBadge status={session.status} />
            <SessionTitleEditor title={session.title} onSave={onUpdateTitle} />
            <Badge variant="outline" className="shrink-0 capitalize" aria-label={`Agent: ${session.agent_type}`}>
              {session.agent_type}
            </Badge>
            {notice ? <span className="truncate text-sm text-muted-foreground lg:hidden">{notice}</span> : null}
            {streamError ? <span className="truncate text-sm text-destructive lg:hidden">{streamError}</span> : null}
          </div>
          <TooltipProvider>
            <div className="flex shrink-0 items-center gap-2 lg:hidden">
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

      <Tabs
        value={messageView}
        onValueChange={(value) => onMessageViewChange(value as MessageView)}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <div className="shrink-0 border-b border-border/70 bg-surface/58 px-4 py-2 lg:hidden">
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
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-background/98 via-background/82 to-transparent backdrop-blur-[2px] [mask-image:linear-gradient(to_top,black_0%,black_68%,transparent_100%)]"
        />
        <div className="pointer-events-auto relative">
          <PromptComposer
            agentType={session.agent_type}
            disabled={composerDisabled}
            disabledReason={disabledReason}
            thinking={session.status === 'running'}
            onSubmit={onSubmitPrompt}
            onCancel={session.status === 'running' ? onCancel : undefined}
          />
        </div>
      </div>
    </section>
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
