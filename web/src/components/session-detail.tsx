import { Loader2 } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  AgentEvent,
  MessageAttachment,
  Session,
  SkillReference,
  SubmitAgentOptions,
  SubmitMessageResponse,
  UserInputAnswers,
} from '@/lib/api'
import type { StreamState } from '@/hooks/use-session-events'
import { ChatTranscript } from '@/components/chat-transcript'
import { PromptComposer } from '@/components/prompt-composer'
import { PermissionQueue } from '@/components/permission-queue'
import { SessionTitle } from '@/components/session-title-editor'
import { UserInputCard } from '@/components/user-input-card'
import {
  activeRunActivity,
  activeStreamingResponse,
  activeThinking,
  activeToolActivity,
  latestTerminalEvent,
  pendingUserInputRequest,
  pendingPermissionRequests,
  type ChatTranscriptMessage,
  type TranscriptSequenceRange,
} from '@/lib/events'
import { cn } from '@/lib/utils'

type Props = {
  session: Session | null
  resolvingSessionID?: string | null
  events: AgentEvent[]
  liveEvents?: AgentEvent[]
  streamState: StreamState
  hasOlderEvents?: boolean
  hasNewerEvents?: boolean
  loadingOlderEvents?: boolean
  loadingNewerEvents?: boolean
  errorMessage?: string
  showDebugEvents: boolean
  onLoadOlderEvents?: () => Promise<void> | void
  onLoadNewerEvents?: () => Promise<void> | void
  onJumpToLatest?: () => Promise<void> | void
  onFollowingTailChange?: (following: boolean) => void
  onSubmitPrompt: (
    content: string,
    agentOptions?: SubmitAgentOptions,
    attachments?: MessageAttachment[],
    queue?: boolean,
    skills?: SkillReference[],
    clientSubmissionID?: string,
  ) => Promise<SubmitMessageResponse | void>
  onAnswerUserInput: (requestID: string, answers: UserInputAnswers) => Promise<void>
  onResolvePermission?: (requestID: string, optionID: string) => Promise<void>
  onCancel: () => Promise<void>
  onOpenFilePath?: (path: string) => Promise<void> | void
  onComposerFocus?: () => void
  composerFocusRequest?: number
  onErrorMessageChange?: (message: string) => void
  headerActions?: ReactNode
  mobileLeadingAction?: ReactNode
  focusedEventSeq?: number
  focusedEventRequest?: number
  onVisibleSequenceRangeChange?: (range: TranscriptSequenceRange | null) => void
}

export function SessionDetail({
  session,
  resolvingSessionID = null,
  events,
  liveEvents,
  streamState,
  hasOlderEvents = false,
  hasNewerEvents = false,
  loadingOlderEvents = false,
  loadingNewerEvents = false,
  errorMessage = '',
  showDebugEvents,
  onLoadOlderEvents,
  onLoadNewerEvents,
  onJumpToLatest,
  onFollowingTailChange,
  onSubmitPrompt,
  onAnswerUserInput,
  onResolvePermission = async () => undefined,
  onCancel,
  onOpenFilePath,
  onComposerFocus,
  composerFocusRequest = 0,
  onErrorMessageChange,
  headerActions,
  mobileLeadingAction,
  focusedEventSeq = 0,
  focusedEventRequest = 0,
  onVisibleSequenceRangeChange,
}: Props) {
  const bottomInsetRef = useRef<HTMLDivElement>(null)
  const [bottomInsetHeight, setBottomInsetHeight] = useState(0)
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatTranscriptMessage[]>([])
  const statusEvents = liveEvents ?? events
  const persistedClientSubmissionIDs = useMemo(() => clientSubmissionIDs(events), [events])
  const visibleOptimisticUserMessages = useMemo(
    () => optimisticUserMessages.filter((message) => !persistedClientSubmissionIDs.has(message.id)),
    [optimisticUserMessages, persistedClientSubmissionIDs],
  )
  const userInputRequest = useMemo(
    () => (session?.status === 'running' ? pendingUserInputRequest(statusEvents) : null),
    [session?.status, statusEvents],
  )
  const permissionRequests = useMemo(
    () => (session?.status === 'running' ? pendingPermissionRequests(statusEvents) : []),
    [session?.status, statusEvents],
  )
  const thinking = useMemo(
    () => session?.status === 'running' && !userInputRequest && activeThinking(statusEvents),
    [session?.status, statusEvents, userInputRequest],
  )
  const runActivity = useMemo(
    () => (session?.status === 'running' && !userInputRequest ? activeRunActivity(statusEvents) : null),
    [session?.status, statusEvents, userInputRequest],
  )
  const streamingResponse = useMemo(
    () => session?.status === 'running' && !userInputRequest && activeStreamingResponse(statusEvents),
    [session?.status, statusEvents, userInputRequest],
  )
  const activeTool = useMemo(
    () => session?.status === 'running' && !userInputRequest && activeToolActivity(statusEvents),
    [session?.status, statusEvents, userInputRequest],
  )
  const activityStatus = thinking
    ? ({ kind: 'thinking' } as const)
    : runActivity && !streamingResponse && !activeTool
      ? ({ kind: 'working', since: runActivity.lastVisibleActivityAt } as const)
      : null
  const latestTerminal = useMemo(() => latestTerminalEvent(statusEvents), [statusEvents])
  const latestQueueEvent = useMemo(() => latestQueuedMessageEvent(statusEvents), [statusEvents])

  useEffect(() => {
    setOptimisticUserMessages([])
  }, [session?.id])

  useEffect(() => {
    if (persistedClientSubmissionIDs.size === 0) return
    setOptimisticUserMessages((current) => {
      const next = current.filter((message) => !persistedClientSubmissionIDs.has(message.id))
      return next.length === current.length ? current : next
    })
  }, [persistedClientSubmissionIDs])

  const handleSubmitPrompt = useCallback(async (
    content: string,
    agentOptions?: SubmitAgentOptions,
    attachments: MessageAttachment[] = [],
    queue = false,
    skills: SkillReference[] = [],
  ) => {
    if (queue) {
      return onSubmitPrompt(content, agentOptions, attachments, true, skills)
    }

    const clientSubmissionID = newClientSubmissionID()
    const submittedAt = new Date().toISOString()
    const optimisticMessage: ChatTranscriptMessage = {
      id: clientSubmissionID,
      role: 'user',
      label: 'You',
      variant: 'default',
      text: content,
      attachments: attachments.map((attachment) => ({
        name: attachment.name,
        mediaType: attachment.media_type,
        dataURL: attachment.data_url,
        sourceURL: attachment.data_url,
        sizeBytes: attachment.size_bytes,
      })),
      skills,
      status: 'pending',
      createdAt: submittedAt,
      completedAt: '',
      durationMs: null,
      tools: [],
      streaming: false,
      startSeq: 0,
      endSeq: 0,
    }
    setOptimisticUserMessages((current) => [...current, optimisticMessage])

    try {
      const response = await onSubmitPrompt(
        content,
        agentOptions,
        attachments,
        false,
        skills,
        clientSubmissionID,
      )
      if (response?.accepted_as === 'queued') {
        setOptimisticUserMessages((current) => current.filter((message) => message.id !== clientSubmissionID))
      }
      return response
    } catch (error) {
      setOptimisticUserMessages((current) => current.filter((message) => message.id !== clientSubmissionID))
      throw error
    }
  }, [onSubmitPrompt])

  useLayoutEffect(() => {
    const element = bottomInsetRef.current
    if (!element) {
      return
    }
    const target = element

    function updateHeight() {
      const nextHeight = measureBottomStackHeight(target)
      if (nextHeight < 1) {
        return
      }
      setBottomInsetHeight((current) => (current === nextHeight ? current : nextHeight))
    }

    updateHeight()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateHeight)
      return () => window.removeEventListener('resize', updateHeight)
    }

    const observer = new ResizeObserver(() => updateHeight())
    observer.observe(target)
    return () => observer.disconnect()
  }, [session?.id, userInputRequest, permissionRequests.length])

  if (!session) {
    if (resolvingSessionID) {
      return (
        <section className="command-workspace flex h-full w-full min-h-0 flex-col items-center justify-center overflow-hidden p-8 text-center">
          <Loader2 className="mb-3 size-5 animate-spin text-muted-foreground" aria-hidden="true" />
          <h2 className="text-lg font-semibold">Loading session...</h2>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">Loading session details and chat history.</p>
        </section>
      )
    }

    return (
      <section className="command-workspace flex h-full w-full min-h-0 flex-col items-center justify-center overflow-hidden p-8 text-center">
        <h2 className="text-lg font-semibold">No session selected</h2>
        {errorMessage ? (
          <p role="alert" className="mt-2 max-w-sm text-sm text-destructive">
            {errorMessage}
          </p>
        ) : (
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">
            Create or select a session to monitor agent work.
          </p>
        )}
      </section>
    )
  }

  if (resolvingSessionID && streamState === 'loading' && events.length === 0) {
    return (
      <section className="command-workspace flex h-full w-full min-h-0 flex-col items-center justify-center overflow-hidden p-8 text-center">
        <Loader2 className="mb-3 size-5 animate-spin text-muted-foreground" aria-hidden="true" />
        <h2 className="text-lg font-semibold">Loading session...</h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">Loading session details and chat history.</p>
      </section>
    )
  }

  const composerDisabled = session.status === 'running'
  const disabledReason = session.status === 'running' ? 'This session is running.' : ''

  return (
    <section className="relative h-full w-full min-h-0 overflow-hidden bg-transparent">
      <div className="absolute inset-0 overflow-hidden">
        <ChatTranscript
          key={session.id}
          events={events}
          optimisticUserMessages={visibleOptimisticUserMessages}
          loading={streamState === 'loading'}
          error={errorMessage}
          topInset="sessionHeader"
          bottomInsetHeight={bottomInsetHeight}
          pinToLatestOnMount
          autoScroll={session.status === 'running' && !userInputRequest}
          activityStatus={activityStatus}
          showDebugEvents={showDebugEvents}
          hasOlderEvents={hasOlderEvents}
          hasNewerEvents={hasNewerEvents}
          loadingOlderEvents={loadingOlderEvents}
          loadingNewerEvents={loadingNewerEvents}
          onLoadOlderEvents={onLoadOlderEvents}
          onLoadNewerEvents={onLoadNewerEvents}
          onJumpToLatest={onJumpToLatest}
          onFollowingTailChange={onFollowingTailChange}
          onOpenFilePath={onOpenFilePath}
          focusSeq={focusedEventSeq}
          focusRequest={focusedEventRequest}
          onVisibleSequenceRangeChange={onVisibleSequenceRangeChange}
        />
        <div
          data-testid="mobile-floating-session-header"
          className="mobile-floating-header-shell pointer-events-none absolute inset-x-0 z-20 p-3 lg:hidden"
        >
          <ChatSessionHeader
            session={session}
            headerActions={headerActions}
            leadingAction={mobileLeadingAction}
          />
        </div>
        <div
          data-testid="floating-session-header"
          className="pointer-events-none absolute inset-x-0 top-0 z-20 hidden p-3 lg:block"
        >
          <ChatSessionHeader
            session={session}
            headerActions={headerActions}
          />
        </div>
      </div>
      <div
        ref={bottomInsetRef}
        className="session-bottom-safe-area pointer-events-none absolute inset-x-0 bottom-0 z-20"
      >
        <div data-testid="session-bottom-stack" className="pointer-events-auto relative flex flex-col gap-3 pt-2">
          <PermissionQueue requests={permissionRequests} onResolve={onResolvePermission} />
          <UserInputCard request={userInputRequest} onAnswer={onAnswerUserInput} />
          <PromptComposer
            key={session.id}
            sessionID={session.id}
            agentType={session.agent_type}
            sessionStatus={session.status}
            hasPendingUserInput={Boolean(userInputRequest)}
            latestTerminalEvent={latestTerminal}
            latestQueueEvent={latestQueueEvent}
            disabled={composerDisabled}
            disabledReason={disabledReason}
            onSubmit={handleSubmitPrompt}
            onCancel={session.status === 'running' ? onCancel : undefined}
            onError={onErrorMessageChange}
            onFocus={onComposerFocus}
            focusRequest={composerFocusRequest}
          />
        </div>
      </div>
    </section>
  )
}

function measureBottomStackHeight(element: HTMLElement) {
  return Math.ceil(element.getBoundingClientRect().height)
}

let clientSubmissionSequence = 0

function newClientSubmissionID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  clientSubmissionSequence += 1
  return `client-${Date.now()}-${clientSubmissionSequence}`
}

function clientSubmissionIDs(events: AgentEvent[]) {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.type !== 'user.message.completed' || typeof event.payload !== 'object' || event.payload === null) {
      continue
    }
    const value = (event.payload as Record<string, unknown>).client_submission_id
    if (typeof value === 'string' && value) ids.add(value)
  }
  return ids
}

export function ChatSessionHeader({
  session,
  errorMessage = '',
  headerActions,
  leadingAction,
}: {
  session: Session
  errorMessage?: string
  headerActions?: ReactNode
  leadingAction?: ReactNode
}) {
  return (
    <div className="pointer-events-auto">
      <div
        className={cn(
          'command-chat-header flex min-h-14 items-center justify-between gap-3 border border-border/90 px-3 py-2 shadow-[0_10px_30px_hsl(var(--foreground)/0.10)]',
          errorMessage ? 'rounded-t-xl' : 'rounded-xl',
        )}
      >
        {leadingAction ? <div className="shrink-0">{leadingAction}</div> : null}
        <div className="min-w-0 flex-1">
          <SessionTitle title={session.title} />
        </div>
        {headerActions}
      </div>
      {errorMessage ? (
        <div
          role="alert"
          className="command-error-banner -mt-px rounded-b-xl border-x border-b border-destructive/40 px-3 py-2 text-sm font-medium text-destructive shadow-[0_10px_30px_hsl(var(--foreground)/0.10)]"
        >
          {errorMessage}
        </div>
      ) : null}
    </div>
  )
}

function latestQueuedMessageEvent(events: AgentEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (
      event.type === 'user.message.queued' ||
      event.type === 'user.message.queue.removed' ||
      queuedUserMessageCompleted(event)
    ) {
      return event
    }
  }
  return null
}

function queuedUserMessageCompleted(event: AgentEvent) {
  if (event.type !== 'user.message.completed' || typeof event.payload !== 'object' || event.payload === null) {
    return false
  }
  return 'queue_item_id' in event.payload
}
