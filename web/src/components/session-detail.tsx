import { Archive, Check, Copy, Eraser, FolderCog, Loader2, Minimize2, PanelRightOpen, Settings } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  AgentEvent,
  MessageAttachment,
  Session,
  SessionAgentOptions,
  SkillReference,
  PermissionPolicy,
  SubmitAgentOptions,
  UserInputAnswers,
} from '@/lib/api'
import type { StreamState } from '@/hooks/use-session-events'
import { Button } from '@/components/ui/button'
import { ChangeWorkspaceDialog } from '@/components/change-workspace-dialog'
import { ChatTranscript } from '@/components/chat-transcript'
import { PromptComposer } from '@/components/prompt-composer'
import { PermissionQueue } from '@/components/permission-queue'
import { PermissionPolicyControl } from '@/components/permission-policy-control'
import { SessionRenameForm, SessionTitle } from '@/components/session-title-editor'
import { UserInputCard } from '@/components/user-input-card'
import {
  activeRunActivity,
  activeStreamingResponse,
  activeThinking,
  activeToolActivity,
  latestTerminalEvent,
  pendingUserInputRequest,
  pendingPermissionRequests,
} from '@/lib/events'
import { clipboardCopyErrorMessage, copyText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { useAnchoredPopover } from '@/hooks/use-anchored-popover'

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
  onShowDebugEventsChange: (showDebugEvents: boolean) => void
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
  ) => Promise<void>
  onAnswerUserInput: (requestID: string, answers: UserInputAnswers) => Promise<void>
  onResolvePermission?: (requestID: string, optionID: string) => Promise<void>
  onCancel: () => Promise<void>
  onUpdateTitle: (title: string) => Promise<void>
  onUpdateWorkspace: (workspacePath: string) => Promise<void>
  hasUnsavedWorkspaceFile?: boolean
  onUpdateAgentOptions: (agentOptions: SessionAgentOptions) => Promise<void>
  onOpenFilePath?: (path: string) => Promise<void> | void
  onComposerFocus?: () => void
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
  liveEvents,
  streamState,
  hasOlderEvents = false,
  hasNewerEvents = false,
  loadingOlderEvents = false,
  loadingNewerEvents = false,
  errorMessage = '',
  showDebugEvents,
  onShowDebugEventsChange,
  onLoadOlderEvents,
  onLoadNewerEvents,
  onJumpToLatest,
  onFollowingTailChange,
  onSubmitPrompt,
  onAnswerUserInput,
  onResolvePermission = async () => undefined,
  onCancel,
  onUpdateTitle,
  onUpdateWorkspace,
  hasUnsavedWorkspaceFile = false,
  onUpdateAgentOptions,
  onOpenFilePath,
  onComposerFocus,
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
  const statusEvents = liveEvents ?? events
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
          loading={streamState === 'loading'}
          error=""
          topInset={errorMessage ? 'sessionHeaderAlert' : 'sessionHeader'}
          bottomInsetHeight={bottomInsetHeight}
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
        />
        <div
          data-testid="mobile-floating-session-header"
          className="mobile-floating-header-shell pointer-events-none absolute inset-x-0 z-20 p-3 lg:hidden"
        >
          <ChatSessionHeader
            session={session}
            errorMessage={errorMessage}
            showDebugEvents={showDebugEvents}
            onUpdateTitle={onUpdateTitle}
            onUpdateWorkspace={onUpdateWorkspace}
            hasUnsavedWorkspaceFile={hasUnsavedWorkspaceFile}
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
            session={session}
            errorMessage={errorMessage}
            showDebugEvents={showDebugEvents}
            onUpdateTitle={onUpdateTitle}
            onUpdateWorkspace={onUpdateWorkspace}
            hasUnsavedWorkspaceFile={hasUnsavedWorkspaceFile}
            onUpdateAgentOptions={onUpdateAgentOptions}
            onShowDebugEventsChange={onShowDebugEventsChange}
            headerActions={headerActions}
            mobileSessionActions={null}
          />
        </div>
      </div>
      <div ref={bottomInsetRef} className="session-bottom-safe-area pointer-events-none absolute inset-x-0 bottom-0 z-20">
        <div data-testid="session-bottom-stack" className="pointer-events-auto relative">
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
            onSubmit={onSubmitPrompt}
            onCancel={session.status === 'running' ? onCancel : undefined}
            onError={onErrorMessageChange}
            onFocus={onComposerFocus}
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
  session,
  errorMessage,
  showDebugEvents,
  onUpdateTitle,
  onUpdateWorkspace,
  hasUnsavedWorkspaceFile,
  onUpdateAgentOptions,
  onShowDebugEventsChange,
  headerActions,
  leadingAction,
  mobileSessionActions,
}: {
  session: Session
  errorMessage: string
  showDebugEvents: boolean
  onUpdateTitle: (title: string) => Promise<void>
  onUpdateWorkspace: (workspacePath: string) => Promise<void>
  hasUnsavedWorkspaceFile?: boolean
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
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <SessionTitle title={session.title} />
          <SessionSettingsMenu
            session={session}
            showDebugEvents={showDebugEvents}
            onUpdateTitle={onUpdateTitle}
            onUpdateAgentOptions={onUpdateAgentOptions}
            onUpdateWorkspace={onUpdateWorkspace}
            hasUnsavedWorkspaceFile={hasUnsavedWorkspaceFile}
            onShowDebugEventsChange={onShowDebugEventsChange}
            mobileSessionActions={mobileSessionActions}
          />
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

function SessionSettingsMenu({
  session,
  showDebugEvents,
  onUpdateTitle,
  onUpdateAgentOptions,
  onUpdateWorkspace,
  hasUnsavedWorkspaceFile,
  onShowDebugEventsChange,
  mobileSessionActions,
}: {
  session: Session
  showDebugEvents: boolean
  onUpdateTitle: (title: string) => Promise<void>
  onUpdateAgentOptions: (agentOptions: SessionAgentOptions) => Promise<void>
  onUpdateWorkspace: (workspacePath: string) => Promise<void>
  hasUnsavedWorkspaceFile?: boolean
  onShowDebugEventsChange: (showDebugEvents: boolean) => void
  mobileSessionActions?: MobileSessionActions | null
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const { triggerRef, popoverStyle } = useAnchoredPopover(open)
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false)
  const [copiedField, setCopiedField] = useState<'session' | 'workspace' | null>(null)
  const [copyFailed, setCopyFailed] = useState(false)
  const [savingPermissionPolicy, setSavingPermissionPolicy] = useState(false)
  const permissionPolicy = effectivePermissionPolicy(session)
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
    setCopyFailed(false)
    try {
      await copyText(value)
      setCopiedField(field)
      window.setTimeout(() => setCopiedField(null), 1200)
    } catch {
      setCopiedField(null)
      setCopyFailed(true)
    }
  }

  async function handlePermissionPolicyChange(policy: PermissionPolicy) {
    if (policy === permissionPolicy) return
    if (policy === 'bypass' && !window.confirm('Bypass sandbox and permission checks for future runs in this session?')) return
	setSavingPermissionPolicy(true)
	try {
	  if (session.agent_type === 'claude') await onUpdateAgentOptions({ claude: { permission_policy: policy } })
	  if (session.agent_type === 'codex') await onUpdateAgentOptions({ codex: { permission_policy: policy } })
	  if (session.agent_type === 'opencode') await onUpdateAgentOptions({ opencode: { permission_policy: policy } })
	} finally {
	  setSavingPermissionPolicy(false)
	}
  }

  return (
    <div ref={menuRef} className="relative shrink-0">
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-muted-foreground hover:bg-background/50 hover:text-foreground"
        aria-label="Session settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setCopyFailed(false)
          setOpen((value) => !value)
        }}
      >
        <Settings aria-hidden="true" />
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label="Session settings"
          style={popoverStyle}
          className="z-50 overflow-y-auto rounded-lg border border-border/80 bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <div className="space-y-3">
            <div className="border-b border-border/70 pb-3">
              <SessionRenameForm title={session.title} onSave={onUpdateTitle} />
            </div>
            <CopyableDetailBox
              label="Session key"
              value={session.id}
              copyLabel="Copy session key"
              copied={copiedField === 'session'}
              onCopy={() => void handleCopy(session.id, 'session')}
              scrollX
            />
            <CopyableDetailBox
              label="Workspace path"
              value={session.workspace_path}
              copyLabel="Copy workspace path"
              copied={copiedField === 'workspace'}
              onCopy={() => void handleCopy(session.workspace_path, 'workspace')}
              labelAction={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
                  aria-label="Change workspace"
                  title="Change workspace"
                  disabled={session.status === 'running'}
                  onClick={() => {
                    setOpen(false)
                    setWorkspaceDialogOpen(true)
                  }}
                >
                  <FolderCog aria-hidden="true" />
                </Button>
              }
            />
            {copyFailed ? (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                {clipboardCopyErrorMessage}
              </p>
            ) : null}
            {session.agent_type === 'codex' || session.agent_type === 'claude' || session.agent_type === 'opencode' ? (
              <div className="space-y-2"><p className="text-xs font-medium text-muted-foreground">Permissions</p><PermissionPolicyControl value={permissionPolicy} disabled={savingPermissionPolicy || session.status === 'running'} onChange={(value) => void handlePermissionPolicyChange(value)} /></div>
            ) : null}
            {mobileSessionActions ? (
              <div className="space-y-1 lg:hidden">
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
            <MenuSwitchRow
              label="Debug"
              description="Stream and load provider debug events for this session."
              active={showDebugEvents}
              disabled={false}
              onClick={() => onShowDebugEventsChange(!showDebugEvents)}
            />
          </div>
        </div>
      ) : null}
      <ChangeWorkspaceDialog
        session={session}
        open={workspaceDialogOpen}
        hasUnsavedFile={hasUnsavedWorkspaceFile === true}
        onOpenChange={setWorkspaceDialogOpen}
        onChangeWorkspace={onUpdateWorkspace}
      />
    </div>
  )
}

function effectivePermissionPolicy(session: Session): PermissionPolicy {
  const options = session.agent_type === 'codex' ? session.agent_options?.codex : session.agent_type === 'claude' ? session.agent_options?.claude : session.agent_type === 'opencode' ? session.agent_options?.opencode : undefined
  if (options?.permission_policy) return options.permission_policy
  if ('run_dangerously' in (options ?? {}) && (options as { run_dangerously?: boolean }).run_dangerously) return 'bypass'
  return 'deny'
}

function MenuSwitchRow({
  label,
  description,
  active,
  disabled,
  onClick,
}: {
  label: string
  description: string
  active: boolean
  disabled: boolean
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
      className="flex w-full items-center justify-between gap-3 rounded-md px-1 py-1.5 text-left text-sm transition-colors hover:bg-accent/60 disabled:pointer-events-none disabled:opacity-50"
    >
      <span className="min-w-0">
        <span className="block font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <span
        className={cn(
          'relative inline-flex h-4 w-7 shrink-0 rounded-full border transition-colors',
          active ? 'border-amber-500/50 bg-amber-400 dark:bg-amber-400/70' : 'border-border/80 bg-surface-muted',
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
  labelAction,
  scrollX = false,
}: {
  label: string
  value: string
  copyLabel: string
  copied: boolean
  onCopy: () => void
  labelAction?: ReactNode
  scrollX?: boolean
}) {
  const displayValue = value || 'Unavailable'

  return (
    <div>
      <div className="flex min-h-6 items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
        {labelAction}
      </div>
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
