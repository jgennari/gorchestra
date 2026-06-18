import { Check, Copy, Ellipsis, RefreshCcw } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentEvent,
  MessageAttachment,
  Session,
  SessionAgentOptions,
  SubmitAgentOptions,
  UserInputAnswers,
} from '@/lib/api'
import type { StreamState } from '@/hooks/use-session-events'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { ChatTranscript } from '@/components/chat-transcript'
import { PromptComposer } from '@/components/prompt-composer'
import { SessionTitleEditor } from '@/components/session-title-editor'
import { UserInputCard } from '@/components/user-input-card'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { activeThinking, latestTerminalEvent, pendingUserInputRequest } from '@/lib/events'
import { cn } from '@/lib/utils'

type Props = {
  session: Session | null
  events: AgentEvent[]
  streamState: StreamState
  streamError: string
  hasOlderEvents?: boolean
  loadingOlderEvents?: boolean
  errorMessage?: string
  notice: string
  showDebugEvents: boolean
  onShowDebugEventsChange: (showDebugEvents: boolean) => void
  onLoadOlderEvents?: () => Promise<void> | void
  onSubmitPrompt: (
    content: string,
    agentOptions?: SubmitAgentOptions,
    attachments?: MessageAttachment[],
  ) => Promise<void>
  onAnswerUserInput: (requestID: string, answers: UserInputAnswers) => Promise<void>
  onCancel: () => Promise<void>
  onRefresh: () => void
  onUpdateTitle: (title: string) => Promise<void>
  onTitleEditStateChange?: (state: { editorID: string; editing: boolean; dirty: boolean }) => void
  onUpdateAgentOptions: (agentOptions: SessionAgentOptions) => Promise<void>
  onOpenFilePath?: (path: string) => Promise<void> | void
  onErrorMessageChange?: (message: string) => void
}

export function SessionDetail({
  session,
  events,
  streamState,
  streamError,
  hasOlderEvents = false,
  loadingOlderEvents = false,
  errorMessage = '',
  notice,
  showDebugEvents,
  onShowDebugEventsChange,
  onLoadOlderEvents,
  onSubmitPrompt,
  onAnswerUserInput,
  onCancel,
  onRefresh,
  onUpdateTitle,
  onTitleEditStateChange,
  onUpdateAgentOptions,
  onOpenFilePath,
  onErrorMessageChange,
}: Props) {
  const userInputRequest = useMemo(
    () => (session?.status === 'running' ? pendingUserInputRequest(events) : null),
    [events, session?.status],
  )
  const thinking = useMemo(
    () => session?.status === 'running' && !userInputRequest && activeThinking(events),
    [events, session?.status, userInputRequest],
  )
  const latestTerminal = useMemo(() => latestTerminalEvent(events), [events])
  const bottomStackRef = useRef<HTMLDivElement>(null)
  const [bottomInsetHeight, setBottomInsetHeight] = useState(176)

  useLayoutEffect(() => {
    const element = bottomStackRef.current
    if (!element) {
      return
    }
    const target = element

    function updateHeight() {
      const nextHeight = Math.ceil(target.getBoundingClientRect().height)
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

  const composerDisabled = session.status === 'running'
  const disabledReason = session.status === 'running' ? 'This session is running.' : ''

  return (
    <section className="relative flex h-full w-full min-h-0 flex-col overflow-hidden bg-transparent">
      <header
        data-testid="session-detail-mobile-header"
        className="hidden shrink-0 border-b border-border/70 bg-background/62 px-4 py-2 backdrop-blur"
      >
        <div className="flex min-h-10 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <StatusBadge status={session.status} />
            <SessionTitleEditor
              key={`mobile-${session.id}`}
              title={session.title}
              onSave={onUpdateTitle}
              onEditStateChange={onTitleEditStateChange}
            />
            <Badge variant="outline" className="shrink-0 capitalize" aria-label={`Agent: ${session.agent_type}`}>
              {session.agent_type}
            </Badge>
            {notice && !errorMessage ? (
              <span className="truncate text-sm text-muted-foreground lg:hidden">{notice}</span>
            ) : null}
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
          error=""
          topInset={errorMessage ? 'sessionHeaderAlert' : 'sessionHeader'}
          bottomInsetHeight={bottomInsetHeight}
          thinking={thinking}
          showDebugEvents={showDebugEvents}
          hasOlderEvents={hasOlderEvents}
          loadingOlderEvents={loadingOlderEvents}
          onLoadOlderEvents={onLoadOlderEvents}
          onOpenFilePath={onOpenFilePath}
        />
        <div data-testid="floating-session-header" className="pointer-events-none absolute inset-x-0 top-0 z-20 hidden p-3 lg:block">
          <ChatSessionHeader
            sessionID={session.id}
            agentType={session.agent_type}
            workspacePath={session.workspace_path}
            agentOptions={session.agent_options}
            title={session.title}
            errorMessage={errorMessage}
            onUpdateTitle={onUpdateTitle}
            onTitleEditStateChange={onTitleEditStateChange}
            onUpdateAgentOptions={onUpdateAgentOptions}
          />
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
        <div ref={bottomStackRef} className="pointer-events-auto relative">
          <UserInputCard request={userInputRequest} onAnswer={onAnswerUserInput} />
          <PromptComposer
            key={session.id}
            sessionID={session.id}
            agentType={session.agent_type}
            sessionStatus={session.status}
            hasPendingUserInput={Boolean(userInputRequest)}
            latestTerminalEvent={latestTerminal}
            disabled={composerDisabled}
            disabledReason={disabledReason}
            showDebugEvents={showDebugEvents}
            onSubmit={onSubmitPrompt}
            onShowDebugEventsChange={onShowDebugEventsChange}
            onCancel={session.status === 'running' ? onCancel : undefined}
            onError={onErrorMessageChange}
          />
        </div>
      </div>
    </section>
  )
}

function ChatSessionHeader({
  sessionID,
  agentType,
  workspacePath,
  agentOptions,
  title,
  errorMessage,
  onUpdateTitle,
  onTitleEditStateChange,
  onUpdateAgentOptions,
}: {
  sessionID: string
  agentType: Session['agent_type']
  workspacePath: string
  agentOptions?: SessionAgentOptions
  title: string
  errorMessage: string
  onUpdateTitle: (title: string) => Promise<void>
  onTitleEditStateChange?: (state: { editorID: string; editing: boolean; dirty: boolean }) => void
  onUpdateAgentOptions: (agentOptions: SessionAgentOptions) => Promise<void>
}) {
  return (
    <div className="pointer-events-auto">
      <div
        className={cn(
          'command-chat-header flex min-h-14 items-center justify-between gap-3 border border-border/90 px-3 py-2 shadow-[0_10px_30px_hsl(var(--foreground)/0.10)]',
          errorMessage ? 'rounded-t-xl' : 'rounded-xl',
        )}
      >
        <div className="min-w-0 flex-1">
          <SessionTitleEditor
            key={`desktop-${sessionID}`}
            title={title}
            onSave={onUpdateTitle}
            onEditStateChange={onTitleEditStateChange}
          />
        </div>
        <SessionDetailsMenu
          sessionID={sessionID}
          agentType={agentType}
          workspacePath={workspacePath}
          agentOptions={agentOptions}
          onUpdateAgentOptions={onUpdateAgentOptions}
        />
      </div>
      {errorMessage ? (
        <div
          role="alert"
          className="-mt-px rounded-b-xl border-x border-b border-destructive/40 bg-destructive/12 px-3 py-2 text-sm font-medium text-destructive shadow-[0_10px_30px_hsl(var(--foreground)/0.10)]"
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
  onUpdateAgentOptions,
}: {
  sessionID: string
  agentType: Session['agent_type']
  workspacePath: string
  agentOptions?: SessionAgentOptions
  onUpdateAgentOptions: (agentOptions: SessionAgentOptions) => Promise<void>
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [copiedField, setCopiedField] = useState<'session' | 'workspace' | null>(null)
  const [savingRunDangerously, setSavingRunDangerously] = useState(false)
  const runDangerously =
    agentType === 'claude' ? agentOptions?.claude?.run_dangerously === true : agentOptions?.codex?.run_dangerously === true

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
            {agentType === 'codex' || agentType === 'claude' ? (
              <label
                className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
                htmlFor="session-run-dangerously"
              >
                <input
                  id="session-run-dangerously"
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--danger))]"
                  checked={runDangerously}
                  disabled={savingRunDangerously}
                  onChange={(event) => void handleRunDangerouslyChange(event.target.checked)}
                />
                <span className="min-w-0">
                  <span className="block font-medium text-destructive">Run dangerously</span>
                  <span className="block text-xs text-muted-foreground">
                    {agentType === 'claude'
                      ? 'Save this session to run Claude with permission prompts skipped on the next run.'
                      : 'Save this session to run Codex without approval prompts or sandbox restrictions on the next run.'}
                  </span>
                </span>
              </label>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
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
