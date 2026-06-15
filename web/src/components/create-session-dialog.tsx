import { ChevronUp, Folder, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { AgentType, Session, SessionAgentOptions, WorkspaceEntry, WorkspaceRoot } from '@/lib/api'
import { browseWorkspace, isAgentType, listWorkspaceRoots } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (params: {
    agent_type: AgentType
    title?: string
    workspace_path?: string
    agent_options?: SessionAgentOptions
  }) => Promise<Session>
}

export function CreateSessionDialog({ open, onOpenChange, onCreate }: Props) {
  const [agentType, setAgentType] = useState<AgentType>('codex')
  const [title, setTitle] = useState('')
  const [roots, setRoots] = useState<WorkspaceRoot[]>([])
  const [rootID, setRootID] = useState('')
  const [workspacePath, setWorkspacePath] = useState('')
  const [currentPath, setCurrentPath] = useState('')
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [runDangerously, setRunDangerously] = useState(false)
  const [loadingWorkspace, setLoadingWorkspace] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const selectedRoot = useMemo(() => roots.find((root) => root.id === rootID) ?? null, [rootID, roots])

  useEffect(() => {
    if (!open) {
      return
    }

    let cancelled = false
    async function loadRoots() {
      setLoadingWorkspace(true)
      setError('')
      try {
        const nextRoots = await listWorkspaceRoots()
        if (cancelled) return
        setRoots(nextRoots)
        const nextRoot = nextRoots.find((root) => root.default) ?? nextRoots[0] ?? null
        setRootID(nextRoot?.id ?? '')
        setCurrentPath('')
        setWorkspacePath(nextRoot?.path ?? '')
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load workspaces')
        }
      } finally {
        if (!cancelled) setLoadingWorkspace(false)
      }
    }

    void loadRoots()
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open || !rootID) {
      setEntries([])
      return
    }

    let cancelled = false
    async function loadDirectory() {
      setLoadingWorkspace(true)
      try {
        const response = await browseWorkspace(rootID, currentPath)
        if (cancelled) return
        setEntries(response.entries.filter((entry) => entry.type === 'directory'))
        setWorkspacePath(joinWorkspacePath(response.root_path, response.path))
      } catch (loadError) {
        if (!cancelled) {
          setEntries([])
          setError(loadError instanceof Error ? loadError.message : 'Failed to browse workspace')
        }
      } finally {
        if (!cancelled) setLoadingWorkspace(false)
      }
    }

    void loadDirectory()
    return () => {
      cancelled = true
    }
  }, [currentPath, open, rootID])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!isAgentType(agentType)) {
      setError('Choose a supported agent.')
      return
    }

    setSubmitting(true)
    setError('')
    try {
      await onCreate({
        agent_type: agentType,
        title: title.trim() || undefined,
        workspace_path: workspacePath || undefined,
        agent_options: agentType === 'codex' && runDangerously ? { codex: { run_dangerously: true } } : undefined,
      })
      setTitle('')
      setAgentType('codex')
      setRunDangerously(false)
      onOpenChange(false)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create session')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create session</DialogTitle>
          <DialogDescription>Select an agent and optional title.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="session-title">
              Title
            </label>
            <Input
              id="session-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Refactor auth middleware"
            />
          </div>
          {agentType === 'codex' ? (
            <label
              className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
              htmlFor="run-dangerously"
            >
              <Input
                id="run-dangerously"
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--danger))]"
                checked={runDangerously}
                onChange={(event) => setRunDangerously(event.target.checked)}
              />
              <span className="min-w-0">
                <span className="block font-medium text-destructive">Run dangerously</span>
                <span className="block text-xs text-muted-foreground">
                  Start Codex without approval prompts or sandbox restrictions.
                </span>
              </span>
            </label>
          ) : null}
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="agent-type">
              Agent
            </label>
            <Select value={agentType} onValueChange={(value) => setAgentType(value as AgentType)}>
              <SelectTrigger id="agent-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fake">Fake</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="workspace-path">
              Workspace
            </label>
            <Input id="workspace-path" value={workspacePath || 'No workspace roots configured'} readOnly />
            <div className="rounded-md border border-border/70 bg-surface-muted/40">
              <div className="flex items-center gap-2 border-b border-border/60 px-2 py-2">
                {roots.length > 1 ? (
                  <Select
                    value={rootID}
                    onValueChange={(value) => {
                      const root = roots.find((item) => item.id === value)
                      setRootID(value)
                      setCurrentPath('')
                      setWorkspacePath(root?.path ?? '')
                    }}
                  >
                    <SelectTrigger className="h-8 min-w-0 flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {roots.map((root) => (
                        <SelectItem key={root.id} value={root.id}>
                          {root.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {selectedRoot?.name ?? 'Workspace root'}
                  </div>
                )}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  disabled={!currentPath || loadingWorkspace}
                  onClick={() => setCurrentPath(parentPath(currentPath))}
                  aria-label="Go to parent directory"
                >
                  <ChevronUp className="size-4" aria-hidden="true" />
                </Button>
              </div>
              <div className="max-h-44 overflow-auto p-1">
                {loadingWorkspace ? (
                  <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    Loading directories
                  </div>
                ) : entries.length > 0 ? (
                  entries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-muted"
                      onClick={() => setCurrentPath(entry.path)}
                    >
                      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="truncate">{entry.name}</span>
                    </button>
                  ))
                ) : (
                  <p className="px-2 py-3 text-xs text-muted-foreground">No child directories</p>
                )}
              </div>
            </div>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Creating' : 'Create'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function joinWorkspacePath(rootPath: string, relativePath: string) {
  if (!relativePath) return rootPath
  return `${rootPath.replace(/\/$/, '')}/${relativePath}`
}

function parentPath(path: string) {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}
