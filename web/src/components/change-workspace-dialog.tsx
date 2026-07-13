import { AlertTriangle, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Session } from '@/lib/api'
import { getConsoleStatus } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { WorkspacePicker } from '@/components/workspace-picker'

export function ChangeWorkspaceDialog({
  session,
  open,
  hasUnsavedFile,
  onOpenChange,
  onChangeWorkspace,
}: {
  session: Session
  open: boolean
  hasUnsavedFile: boolean
  onOpenChange: (open: boolean) => void
  onChangeWorkspace: (workspacePath: string) => Promise<void>
}) {
  const [workspacePath, setWorkspacePath] = useState(session.workspace_path)
  const [checkingConsole, setCheckingConsole] = useState(false)
  const [consoleRunning, setConsoleRunning] = useState(false)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const agentRunning = session.status === 'running'
  const blocked = agentRunning || consoleRunning
  const unchanged = workspacePath === session.workspace_path

  useEffect(() => {
    if (!open) return
    setWorkspacePath(session.workspace_path)
    setConfirmingDiscard(false)
    setError('')
    setCheckingConsole(true)
    let cancelled = false
    void getConsoleStatus(session.id)
      .then((status) => {
        if (!cancelled) setConsoleRunning(status.running)
      })
      .catch(() => {
        if (!cancelled) setConsoleRunning(false)
      })
      .finally(() => {
        if (!cancelled) setCheckingConsole(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, session.id, session.workspace_path])

  async function saveWorkspace() {
    setSubmitting(true)
    setError('')
    try {
      await onChangeWorkspace(workspacePath)
      onOpenChange(false)
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : 'Failed to change workspace')
      setConfirmingDiscard(false)
    } finally {
      setSubmitting(false)
    }
  }

  function requestSave() {
    if (hasUnsavedFile) {
      setConfirmingDiscard(true)
      return
    }
    void saveWorkspace()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change workspace</DialogTitle>
          <DialogDescription>Choose the folder used by future agent runs, files, and consoles.</DialogDescription>
        </DialogHeader>
        <WorkspacePicker initialPath={session.workspace_path} disabled={submitting || blocked} onPathChange={setWorkspacePath} />
        {checkingConsole ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Checking console status
          </p>
        ) : agentRunning ? (
          <WorkspaceBlockMessage>Stop the active agent run before changing workspace.</WorkspaceBlockMessage>
        ) : consoleRunning ? (
          <WorkspaceBlockMessage>Stop the active console before changing workspace.</WorkspaceBlockMessage>
        ) : null}
        {confirmingDiscard ? (
          <div className="rounded-md border border-destructive/35 bg-destructive/5 p-3">
            <p className="flex items-center gap-2 text-sm font-medium text-destructive">
              <AlertTriangle className="size-4" aria-hidden="true" />
              Discard unsaved file changes?
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Changing workspaces closes the current file. Its unsaved draft cannot be recovered.
            </p>
          </div>
        ) : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => {
              if (confirmingDiscard) {
                setConfirmingDiscard(false)
              } else {
                onOpenChange(false)
              }
            }}
          >
            {confirmingDiscard ? 'Keep editing' : 'Cancel'}
          </Button>
          <Button
            type="button"
            variant={confirmingDiscard ? 'destructive' : 'default'}
            disabled={submitting || checkingConsole || blocked || unchanged || !workspacePath}
            onClick={() => (confirmingDiscard ? void saveWorkspace() : requestSave())}
          >
            {submitting ? 'Changing' : confirmingDiscard ? 'Discard and change' : 'Change workspace'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function WorkspaceBlockMessage({ children }: { children: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-destructive">
      <AlertTriangle className="size-4" aria-hidden="true" />
      {children}
    </p>
  )
}
