import { Check, Copy, FolderCog, Loader2, Settings } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { ChangeWorkspaceDialog } from '@/components/change-workspace-dialog'
import { PermissionPolicyControl } from '@/components/permission-policy-control'
import { SessionRenameForm } from '@/components/session-title-editor'
import { Button } from '@/components/ui/button'
import type { PermissionPolicy, Session, SessionAgentOptions } from '@/lib/api'
import { clipboardCopyErrorMessage, copyText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'

export function SessionSettings({
  session,
  resolvingSessionID,
  showDebugEvents,
  onUpdateTitle,
  onUpdateWorkspace,
  hasUnsavedWorkspaceFile = false,
  onUpdateAgentOptions,
  onShowDebugEventsChange,
}: {
  session: Session | null
  resolvingSessionID?: string | null
  showDebugEvents: boolean
  onUpdateTitle: (title: string) => Promise<void>
  onUpdateWorkspace: (workspacePath: string) => Promise<void>
  hasUnsavedWorkspaceFile?: boolean
  onUpdateAgentOptions: (agentOptions: SessionAgentOptions) => Promise<void>
  onShowDebugEventsChange: (showDebugEvents: boolean) => void
}) {
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false)
  const [copiedField, setCopiedField] = useState<'session' | 'workspace' | null>(null)
  const [copyFailed, setCopyFailed] = useState(false)
  const [savingPermissionPolicy, setSavingPermissionPolicy] = useState(false)

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {resolvingSessionID ? (
          <span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" />Loading settings…</span>
        ) : 'Select a session'}
      </div>
    )
  }

  const activeSession = session
  const permissionPolicy = effectivePermissionPolicy(session)

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
      if (activeSession.agent_type === 'claude') await onUpdateAgentOptions({ claude: { permission_policy: policy } })
      if (activeSession.agent_type === 'codex') await onUpdateAgentOptions({ codex: { permission_policy: policy } })
      if (activeSession.agent_type === 'opencode') await onUpdateAgentOptions({ opencode: { permission_policy: policy } })
    } finally {
      setSavingPermissionPolicy(false)
    }
  }

  return (
    <div className="session-settings-body flex h-full min-h-0 flex-col overflow-y-auto px-3 pb-3">
      <div className="flex min-h-0 w-full flex-1 flex-col gap-3 pb-16">
        <section className="shrink-0 rounded-lg border border-border/80 bg-background/72 p-4 shadow-sm" aria-labelledby="session-settings-heading">
          <div className="flex items-center gap-2">
            <Settings className="size-5 text-primary" aria-hidden="true" />
            <h1 id="session-settings-heading" className="text-base font-semibold">Session settings</h1>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Manage this session’s identity, workspace, permissions, and event visibility.</p>
        </section>

        <section className="rounded-lg border border-border/80 bg-background/72 p-4 shadow-sm" aria-label="Session configuration">
          <div className="grid gap-5 md:grid-cols-2">
            <div className="md:col-span-2">
              <SessionRenameForm key={`${session.id}:${session.title}`} title={session.title} onSave={onUpdateTitle} />
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
              scrollX
              labelAction={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7"
                  disabled={session.status === 'running'}
                  onClick={() => setWorkspaceDialogOpen(true)}
                >
                  <FolderCog aria-hidden="true" />Change
                </Button>
              }
            />
            {copyFailed ? (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive md:col-span-2">
                {clipboardCopyErrorMessage}
              </p>
            ) : null}
            {session.agent_type === 'codex' || session.agent_type === 'claude' || session.agent_type === 'opencode' ? (
              <div className="space-y-2">
                <div>
                  <p className="text-xs font-medium">Permissions</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Controls approval behavior for future runs.</p>
                </div>
                <PermissionPolicyControl
                  value={permissionPolicy}
                  disabled={savingPermissionPolicy || session.status === 'running'}
                  onChange={(value) => void handlePermissionPolicyChange(value)}
                />
              </div>
            ) : null}
            <MenuSwitchRow
              label="Debug events"
              description="Stream and load provider debug events for this session."
              active={showDebugEvents}
              onClick={() => onShowDebugEventsChange(!showDebugEvents)}
            />
          </div>
        </section>
      </div>
      <ChangeWorkspaceDialog
        session={session}
        open={workspaceDialogOpen}
        hasUnsavedFile={hasUnsavedWorkspaceFile}
        onOpenChange={setWorkspaceDialogOpen}
        onChangeWorkspace={onUpdateWorkspace}
      />
    </div>
  )
}

function effectivePermissionPolicy(session: Session): PermissionPolicy {
  const options = session.agent_type === 'codex'
    ? session.agent_options?.codex
    : session.agent_type === 'claude'
      ? session.agent_options?.claude
      : session.agent_type === 'opencode'
        ? session.agent_options?.opencode
        : undefined
  if (options?.permission_policy) return options.permission_policy
  if ('run_dangerously' in (options ?? {}) && (options as { run_dangerously?: boolean }).run_dangerously) return 'bypass'
  return 'deny'
}

function MenuSwitchRow({ label, description, active, onClick }: { label: string; description: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={active}
      aria-pressed={active}
      onClick={onClick}
      className="flex w-full items-center justify-between gap-3 self-end rounded-md border border-border/80 bg-surface-muted/35 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/60"
    >
      <span className="min-w-0">
        <span className="block font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <span className={cn('relative inline-flex h-4 w-7 shrink-0 rounded-full border transition-colors', active ? 'border-amber-500/50 bg-amber-400 dark:bg-amber-400/70' : 'border-border/80 bg-surface-muted')} aria-hidden="true">
        <span className={cn('absolute top-1/2 size-3 -translate-y-1/2 rounded-full bg-background shadow-sm transition-transform', active ? 'translate-x-3.5' : 'translate-x-0.5')} />
      </span>
    </button>
  )
}

function CopyableDetailBox({ label, value, copyLabel, copied, onCopy, labelAction, scrollX = false }: { label: string; value: string; copyLabel: string; copied: boolean; onCopy: () => void; labelAction?: ReactNode; scrollX?: boolean }) {
  const displayValue = value || 'Unavailable'
  return (
    <div>
      <div className="flex min-h-7 items-center justify-between gap-2">
        <p className="text-xs font-medium">{label}</p>
        {labelAction}
      </div>
      <div className="relative mt-1.5 rounded-md border border-border/70 bg-surface-muted/55">
        <code className={cn('block px-3 py-2 pr-11 font-mono text-xs text-foreground', scrollX ? 'overflow-x-auto whitespace-nowrap' : 'max-h-24 overflow-auto break-all')} title={value || undefined}>
          {displayValue}
        </code>
        <Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1 h-7 w-7 text-muted-foreground hover:bg-background/80 hover:text-foreground [&_svg]:size-3.5" aria-label={copyLabel} disabled={!value} onClick={onCopy}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
      </div>
    </div>
  )
}
