import { Archive, Check, Copy, Ellipsis, Eraser, Loader2, Minimize2, PanelRightOpen } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  AgentEvent,
  MessageAttachment,
  Session,
  SessionAgentOptions,
  SubmitAgentOptions,
  UserInputAnswers,
} from '@/lib/api'
import type { StreamState } from '@/hooks/use-session-events'
import { Button } from '@/components/ui/button'
import { ChatTranscript } from '@/components/chat-transcript'
import { PromptComposer } from '@/components/prompt-composer'
import { SessionTitleEditor } from '@/components/session-title-editor'
import { UserInputCard } from '@/components/user-input-card'
import {
  activeRunActivity,
  activeStreamingResponse,
  activeThinking,
  activeToolActivity,
  latestTerminalEvent,
  pendingUserInputRequest,
} from '@/lib/events'
import { cn } from '@/lib/utils'

type Props = {
  session: Session | null
  resolvingSessionID?: string | null
  events: AgentEvent[]
  streamState: StreamState
  hasOlderEvents?: boolean
  loadingOlderEvents?: boolean
  errorMessage?: string
  showDebugEvents: boolean
  onShowDebugEventsChange: (showDebugEvents: boolean) => void
  onLoadOlderEvents?: () => Promise<void> | void
  onFollowLatestChange?: (followingLatest: boolean) => void
  onSubmitPrompt: (
    content: string,
    agentOptions?: SubmitAgentOptions,
    attachments?: MessageAttachment[],
    queue?: boolean,
  ) => Promise<void>
  onAnswerUserInput: (requestID: string, answers: UserInputAnswers) => Promise<void>
  onCancel: () => Promise<void>
  onUpdateTitle: (title: string) => Promise<void>
  onTitleEditStateChange?: (state: { editorID: string; editing: boolean; dirty: boolean }) => void
  onUpdateAgentOptions: (agentOptions: SessionAgentOptions) => Promise<void>
  onOpenFilePath?: (path: string) => Promise<void> | void
  onErrorMessageChange?: (message: string) => void
  onClear?: () => Promise<void>
  onCompact?: () => Promise<void>
  onToggleArchive?: () => Promise<void>
  onOpenWorkspaceDetails?: () => void
  clearPending?: boolean
  compactPending?: boolean
  archivePending?: boolean
  headerActions?: ReactNode
  mobileLeadingAction?: ReactNode
}

export function SessionDetail({
  session,
  resolvingSessionID = null,
  events,
  streamState,
  hasOlderEvents = false,
  loadingOlderEvents = false,
  errorMessage = '',
  showDebugEvents,
  onShowDebugEventsChange,
  onLoadOlderEvents,
  onFollowLatestChange,
  onSubmitPrompt,
  onAnswerUserInput,
  onCancel,
  onUpdateTitle,
  onTitleEditStateChange,
  onUpdateAgentOptions,
  onOpenFilePath,
  onErrorMessageChange,
  onClear,
  onCompact,
  onToggleArchive,
  onOpenWorkspaceDetails,
  clearPending = false,
  compactPending = false,
  archivePending = false,
  headerActions,
  mobileLeadingAction,
}: Props) {
  const bottomInsetRef = useRef<HTMLDivElement>(null)
  const [bottomInsetHeight, setBottomInsetHeight] = useState(176)
  const userInputRequest = useMemo(
    () => (session?.status === 'running' ? pendingUserInputRequest(events) : null),
    [events, session?.status],
  )
  const thinking = useMemo(
    () => session?.status === 'running' && !userInputRequest && activeThinking(events),
    [events, session?.status, userInputRequest],
  )
  const runActivity = useMemo(
    () => (session?.status === 'running' && !userInputRequest ? activeRunActivity(events) : null),
    [events, session?.status, userInputRequest],
  )
  const streamingResponse = useMemo(
    () => session?.status === 'running' && !userInputRequest && activeStreamingResponse(events),
    [events, session?.status, userInputRequest],
  )
  const activeTool = useMemo(
    () => session?.status === 'running' && !userInputRequest && activeToolActivity(events),
    [events, session?.status, userInputRequest],
  )
  const activityStatus = thinking
    ? ({ kind: 'thinking' } as const)
    : runActivity && !streamingResponse && !activeTool
      ? ({ kind: 'working', since: runActivity.lastVisibleActivityAt } as const)
      : null
  const latestTerminal = useMemo(() => latestTerminalEvent(events), [events])
  const latestQueueEvent = useMemo(() => latestQueuedMessageEvent(events), [events])

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
  }, [session?.id, userInputRequest])

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
          events={events}
          loading={streamState === 'loading'}
          error=""
          topInset={errorMessage ? 'sessionHeaderAlert' : 'sessionHeader'}
          bottomInsetHeight={bottomInsetHeight}
          activityStatus={activityStatus}
          showDebugEvents={showDebugEvents}
          hasOlderEvents={hasOlderEvents}
          loadingOlderEvents={loadingOlderEvents}
          onLoadOlderEvents={onLoadOlderEvents}
          onFollowLatestChange={onFollowLatestChange}
          onOpenFilePath={onOpenFilePath}
        />
        <div
          data-testid="mobile-floating-session-header"
          className="mobile-floating-header-shell pointer-events-none absolute inset-x-0 z-20 p-3 lg:hidden"
        >
          <ChatSessionHeader
            sessionID={session.id}
            agentType={session.agent_type}
            workspacePath={session.workspace_path}
            agentOptions={session.agent_options}
            title={session.title}
            errorMessage={errorMessage}
            showDebugEvents={showDebugEvents}
            onUpdateTitle={onUpdateTitle}
            onTitleEditStateChange={onTitleEditStateChange}
            onUpdateAgentOptions={onUpdateAgentOptions}
            onShowDebugEventsChange={onShowDebugEventsChange}
            headerActions={headerActions}
            leadingAction={mobileLeadingAction}
            mobileSessionActions={{
              session,
              onClear,
              onCompact,
              onToggleArchive,
              onOpenWorkspaceDetails,
              clearPending,
              compactPending,
              archivePending,
            }}
          />
        </div>
        <div data-testid="floating-session-header" className="pointer-events-none absolute inset-x-0 top-0 z-20 hidden p-3 lg:block">
          <ChatSessionHeader
            sessionID={session.id}
            agentType={session.agent_type}
            workspacePath={session.workspace_path}
            agentOptions={session.agent_options}
            title={session.title}
            errorMessage={errorMessage}
            showDebugEvents={showDebugEvents}
            onUpdateTitle={onUpdateTitle}
            onTitleEditStateChange={onTitleEditStateChange}
            onUpdateAgentOptions={onUpdateAgentOptions}
            onShowDebugEventsChange={onShowDebugEventsChange}
            headerActions={headerActions}
            mobileSessionActions={null}
          />
        </div>
      </div>
      <div ref={bottomInsetRef} className="session-bottom-safe-area pointer-events-none absolute inset-x-0 bottom-0 z-20">
        <div data-testid="session-bottom-stack" className="pointer-events-auto relative">
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
            onSubmit={onSubmitPrompt}
            onCancel={session.status === 'running' ? onCancel : undefined}
            onError={onErrorMessageChange}
          />
        </div>
      </div>
    </section>
  )
}

function measureBottomStackHeight(element: HTMLElement) {
  return Math.ceil(element.getBoundingClientRect().height)
}

export function ChatSessionHeader({
  sessionID,
  agentType,
  workspacePath,
  agentOptions,
  title,
  errorMessage,
  showDebugEvents,
  onUpdateTitle,
  onTitleEditStateChange,
  onUpdateAgentOptions,
  onShowDebugEventsChange,
  headerActions,
  leadingAction,
  mobileSessionActions,
}: {
  sessionID: string
  agentType: Session['agent_type']
  workspacePath: string
  agentOptions?: SessionAgentOptions
  title: string
  errorMessage: string
  showDebugEvents: boolean
  onUpdateTitle: (title: string) => Promise<void>
  onTitleEditStateChange?: (state: { editorID: string; editing: boolean; dirty: boolean }) => void
  onUpdateAgentOptions: (agentOptions: SessionAgentOptions) => Promise<void>
  onShowDebugEventsChange: (showDebugEvents: boolean) => void
  headerActions?: ReactNode
  leadingAction?: ReactNode
  mobileSessionActions?: MobileSessionActions | null
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
          <SessionTitleEditor
            key={`desktop-${sessionID}`}
            title={title}
            onSave={onUpdateTitle}
            onEditStateChange={onTitleEditStateChange}
          />
        </div>
        {headerActions}
        <SessionDetailsMenu
          sessionID={sessionID}
          agentType={agentType}
          workspacePath={workspacePath}
          agentOptions={agentOptions}
          showDebugEvents={showDebugEvents}
          onUpdateAgentOptions={onUpdateAgentOptions}
          onShowDebugEventsChange={onShowDebugEventsChange}
          mobileSessionActions={mobileSessionActions}
        />
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

function SessionDetailsMenu({
  sessionID,
  agentType,
  workspacePath,
  agentOptions,
  showDebugEvents,
  onUpdateAgentOptions,
  onShowDebugEventsChange,
  mobileSessionActions,
}: {
  sessionID: string
  agentType: Session['agent_type']
  workspacePath: string
  agentOptions?: SessionAgentOptions
  showDebugEvents: boolean
  onUpdateAgentOptions: (agentOptions: SessionAgentOptions) => Promise<void>
  onShowDebugEventsChange: (showDebugEvents: boolean) => void
  mobileSessionActions?: MobileSessionActions | null
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [copiedField, setCopiedField] = useState<'session' | 'workspace' | null>(null)
  const [savingRunDangerously, setSavingRunDangerously] = useState(false)
  const runDangerously =
    agentType === 'claude' ? agentOptions?.claude?.run_dangerously === true : agentOptions?.codex?.run_dangerously === true
  const mobileActionPending =
    mobileSessionActions?.clearPending || mobileSessionActions?.compactPending || mobileSessionActions?.archivePending
  const mobileCodexActionDisabled =
    !mobileSessionActions?.session ||
    mobileSessionActions.session.agent_type !== 'codex' ||
    mobileSessionActions.session.status === 'running' ||
    Boolean(mobileSessionActions.session.archived_at) ||
    Boolean(mobileActionPending)
  const mobileCompactDisabled = mobileCodexActionDisabled || !mobileSessionActions?.session?.provider_session_id
  const mobileArchiveDisabled =
    !mobileSessionActions?.session ||
    mobileSessionActions.session.status === 'running' ||
    Boolean(mobileSessionActions.archivePending)

  useEffect(() => {
    if (!open) return

    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  async function handleCopy(value: string, field: 'session' | 'workspace') {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedField(field)
      window.setTimeout(() => setCopiedField(null), 1200)
    } catch {
      setCopiedField(null)
    }
  }

  async function handleRunDangerouslyChange(checked: boolean) {
    setSavingRunDangerously(true)
    try {
      await onUpdateAgentOptions(
        agentType === 'claude' ? { claude: { run_dangerously: checked } } : { codex: { run_dangerously: checked } },
      )
    } finally {
      setSavingRunDangerously(false)
    }
  }

  return (
    <div ref={menuRef} className="relative shrink-0">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-muted-foreground hover:bg-background/50 hover:text-foreground"
        aria-label="Session details"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Ellipsis aria-hidden="true" />
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label="Session details"
          className="absolute right-0 top-full z-50 mt-2 w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-border/80 bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <div className="space-y-3">
            <CopyableDetailBox
              label="Session key"
              value={sessionID}
              copyLabel="Copy session key"
              copied={copiedField === 'session'}
              onCopy={() => void handleCopy(sessionID, 'session')}
              scrollX
            />
            <CopyableDetailBox
              label="Workspace path"
              value={workspacePath}
              copyLabel="Copy workspace path"
              copied={copiedField === 'workspace'}
              onCopy={() => void handleCopy(workspacePath, 'workspace')}
            />
            <MenuSwitchRow
              label="Debug"
              description="Stream and load provider debug events for this session."
              active={showDebugEvents}
              disabled={false}
              onClick={() => onShowDebugEventsChange(!showDebugEvents)}
            />
            {agentType === 'codex' || agentType === 'claude' ? (
              <MenuSwitchRow
                label="Run dangerously"
                description={
                  agentType === 'claude'
                    ? 'Save this session to run Claude with permission prompts skipped on the next run.'
                    : 'Save this session to run Codex without approval prompts or sandbox restrictions on the next run.'
                }
                active={runDangerously}
                disabled={savingRunDangerously}
                destructive
                onClick={() => void handleRunDangerouslyChange(!runDangerously)}
              />
            ) : null}
            {mobileSessionActions ? (
              <div className="space-y-1 border-t border-border/70 pt-3 lg:hidden">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    setOpen(false)
                    mobileSessionActions.onOpenWorkspaceDetails?.()
                  }}
                >
                  <PanelRightOpen className="size-4" aria-hidden="true" />
                  <span>Workspace details</span>
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-45"
                  disabled={mobileCodexActionDisabled}
                  onClick={() => {
                    setOpen(false)
                    void mobileSessionActions.onClear?.()
                  }}
                >
                  {mobileSessionActions.clearPending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Eraser className="size-4" aria-hidden="true" />
                  )}
                  <span>{mobileSessionActions.clearPending ? 'Clearing' : 'Clear context'}</span>
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-45"
                  disabled={mobileCompactDisabled}
                  onClick={() => {
                    setOpen(false)
                    void mobileSessionActions.onCompact?.()
                  }}
                >
                  {mobileSessionActions.compactPending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Minimize2 className="size-4" aria-hidden="true" />
                  )}
                  <span>{mobileSessionActions.compactPending ? 'Compacting' : 'Compact context'}</span>
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-destructive hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-45"
                  disabled={mobileArchiveDisabled}
                  onClick={() => {
                    setOpen(false)
                    void mobileSessionActions.onToggleArchive?.()
                  }}
                >
                  {mobileSessionActions.archivePending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Archive className="size-4" aria-hidden="true" />
                  )}
                  <span>
                    {mobileSessionActions.archivePending
                      ? mobileSessionActions.session?.archived_at
                        ? 'Restoring'
                        : 'Archiving'
                      : mobileSessionActions.session?.archived_at
                        ? 'Restore session'
                        : 'Archive session'}
                  </span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function MenuSwitchRow({
  label,
  description,
  active,
  disabled,
  destructive = false,
  onClick,
}: {
  label: string
  description: string
  active: boolean
  disabled: boolean
  destructive?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={active}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center justify-between gap-3 rounded-md border p-3 text-left text-sm transition-colors disabled:pointer-events-none disabled:opacity-50',
        destructive
          ? 'border-destructive/30 bg-destructive/5 hover:bg-destructive/10'
          : 'border-border/80 bg-surface-muted/40 hover:bg-accent/60',
      )}
    >
      <span className="min-w-0">
        <span className={cn('block font-medium', destructive ? 'text-destructive' : 'text-foreground')}>{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <span
        className={cn(
          'relative inline-flex h-4 w-7 shrink-0 rounded-full border transition-colors',
          active && destructive
            ? 'border-destructive/60 bg-destructive'
            : active
              ? 'border-amber-500/50 bg-amber-400 dark:bg-amber-400/70'
              : 'border-border/80 bg-surface-muted',
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            'absolute top-1/2 size-3 -translate-y-1/2 rounded-full bg-background shadow-sm transition-transform',
            active ? 'translate-x-3.5' : 'translate-x-0.5',
          )}
        />
      </span>
    </button>
  )
}

export type MobileSessionActions = {
  session: Session | null
  onClear?: () => Promise<void>
  onCompact?: () => Promise<void>
  onToggleArchive?: () => Promise<void>
  onOpenWorkspaceDetails?: () => void
  clearPending?: boolean
  compactPending?: boolean
  archivePending?: boolean
}

function CopyableDetailBox({
  label,
  value,
  copyLabel,
  copied,
  onCopy,
  scrollX = false,
}: {
  label: string
  value: string
  copyLabel: string
  copied: boolean
  onCopy: () => void
  scrollX?: boolean
}) {
  const displayValue = value || 'Unavailable'

  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <div className="relative mt-1 rounded-md bg-surface-muted/75">
        <code
          className={cn(
            'block px-2 py-1.5 pr-10 font-mono text-xs text-foreground',
            scrollX ? 'overflow-x-auto whitespace-nowrap' : 'max-h-24 overflow-auto break-all',
          )}
          title={value || undefined}
        >
          {displayValue}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-1 top-1 h-6 w-6 bg-surface-muted/90 text-muted-foreground hover:bg-background/80 hover:text-foreground [&_svg]:size-3.5"
          aria-label={copyLabel}
          disabled={!value}
          onClick={onCopy}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
      </div>
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
