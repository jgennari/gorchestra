import { Check, Copy, RefreshCcw } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { AgentEvent, MessageAttachment, Session, SubmitAgentOptions, UserInputAnswers } from '@/lib/api'
import type { StreamState } from '@/hooks/use-session-events'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { ChatTranscript } from '@/components/chat-transcript'
import { PromptComposer } from '@/components/prompt-composer'
import { SessionTitleEditor } from '@/components/session-title-editor'
import { UserInputCard } from '@/components/user-input-card'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { pendingUserInputRequest } from '@/lib/events'
import { cn } from '@/lib/utils'

type Props = {
  session: Session | null
  events: AgentEvent[]
  streamState: StreamState
  streamError: string
  notice: string
  showDebugEvents: boolean
  onShowDebugEventsChange: (showDebugEvents: boolean) => void
  onSubmitPrompt: (content: string, agentOptions?: SubmitAgentOptions, attachments?: MessageAttachment[]) => Promise<void>
  onAnswerUserInput: (requestID: string, answers: UserInputAnswers) => Promise<void>
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
  showDebugEvents,
  onShowDebugEventsChange,
  onSubmitPrompt,
  onAnswerUserInput,
  onCancel,
  onRefresh,
  onUpdateTitle,
}: Props) {
  const userInputRequest = useMemo(
    () => (session?.status === 'running' ? pendingUserInputRequest(events) : null),
    [events, session?.status],
  )

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

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <ChatTranscript
          events={events}
          loading={streamState === 'loading'}
          error={streamError}
          topInset="sessionHeader"
          bottomInset={userInputRequest ? 'question' : 'composer'}
          showDebugEvents={showDebugEvents}
        />
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 p-3">
          <ChatSessionHeader
            sessionID={session.id}
            title={session.title}
            onUpdateTitle={onUpdateTitle}
          />
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
        <div className="pointer-events-auto relative">
          <UserInputCard request={userInputRequest} onAnswer={onAnswerUserInput} />
          <PromptComposer
            key={session.id}
            sessionID={session.id}
            agentType={session.agent_type}
            disabled={composerDisabled}
            disabledReason={disabledReason}
            thinking={session.status === 'running' && !userInputRequest}
            showDebugEvents={showDebugEvents}
            onSubmit={onSubmitPrompt}
            onShowDebugEventsChange={onShowDebugEventsChange}
            onCancel={session.status === 'running' ? onCancel : undefined}
          />
        </div>
      </div>
    </section>
  )
}

function ChatSessionHeader({
  sessionID,
  title,
  onUpdateTitle,
}: {
  sessionID: string
  title: string
  onUpdateTitle: (title: string) => Promise<void>
}) {
  return (
    <div className="command-chat-header pointer-events-auto flex min-h-14 items-center justify-between gap-3 rounded-xl border border-border/90 px-3 py-2 shadow-[0_10px_30px_hsl(var(--foreground)/0.10)]">
      <div className="min-w-0 flex-1">
        <SessionTitleEditor title={title} onSave={onUpdateTitle} />
      </div>
      <SessionIDCopy sessionID={sessionID} />
    </div>
  )
}

function SessionIDCopy({ sessionID }: { sessionID: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(sessionID)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="flex min-w-0 max-w-[45%] shrink items-center gap-1.5 rounded-md bg-background/30 px-2 py-1">
      <code className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/90">
        {sessionID}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
        aria-label="Copy session id"
        onClick={() => void handleCopy()}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
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
