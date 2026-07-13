import { Folder, Info, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { WorkspaceEntry, WorkspaceRoot } from '@/lib/api'
import { browseWorkspace, listWorkspaceRoots } from '@/lib/api'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export function WorkspacePicker({
  initialPath = '',
  disabled = false,
  onPathChange,
}: {
  initialPath?: string
  disabled?: boolean
  onPathChange: (path: string) => void
}) {
  const [roots, setRoots] = useState<WorkspaceRoot[]>([])
  const [rootID, setRootID] = useState('')
  const [currentPath, setCurrentPath] = useState('')
  const [workspacePath, setWorkspacePath] = useState('')
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const isAtWorkspaceRoot = currentPath === ''

  useEffect(() => {
    let cancelled = false
    async function loadRoots() {
      setLoading(true)
      setError('')
      try {
        const nextRoots = await listWorkspaceRoots()
        if (cancelled) return
        setRoots(nextRoots)
        const location = workspaceLocation(nextRoots, initialPath)
        setRootID(location.root?.id ?? '')
        setCurrentPath(location.relativePath)
        const nextPath = location.root ? joinWorkspacePath(location.root.path, location.relativePath) : ''
        setWorkspacePath(nextPath)
        onPathChange(nextPath)
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load workspaces')
          onPathChange('')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadRoots()
    return () => {
      cancelled = true
    }
  }, [initialPath, onPathChange])

  useEffect(() => {
    if (!rootID) {
      setEntries([])
      return
    }

    let cancelled = false
    async function loadDirectory() {
      setLoading(true)
      setError('')
      try {
        const response = await browseWorkspace(rootID, currentPath)
        if (cancelled) return
        setEntries(response.entries.filter((entry) => entry.type === 'directory'))
        const nextPath = joinWorkspacePath(response.root_path, response.path)
        setWorkspacePath(nextPath)
        onPathChange(nextPath)
      } catch (loadError) {
        if (!cancelled) {
          setEntries([])
          setError(loadError instanceof Error ? loadError.message : 'Failed to browse workspace')
          onPathChange('')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadDirectory()
    return () => {
      cancelled = true
    }
  }, [currentPath, onPathChange, rootID])

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">Workspace</div>
      <div className="rounded-md border border-border/70 bg-background">
        <div className="border-b border-border/60 px-2 py-2">
          {roots.length > 1 ? (
            <Select
              disabled={disabled}
              value={rootID}
              onValueChange={(value) => {
                const root = roots.find((item) => item.id === value)
                setRootID(value)
                setCurrentPath('')
                setWorkspacePath(root?.path ?? '')
              }}
            >
              <SelectTrigger className="h-8 min-w-0">
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
          ) : null}
          <div className={roots.length > 1 ? 'mt-1 flex items-center gap-2' : 'flex items-center gap-2'}>
            <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={workspacePath}>
              {workspacePath || 'No workspace roots configured'}
            </p>
            <WorkspaceHelpTooltip />
          </div>
        </div>
        <div className="max-h-52 overflow-auto p-1">
          {loading ? (
            <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Loading directories
            </div>
          ) : (
            <div className="space-y-0.5">
              {!isAtWorkspaceRoot ? (
                <>
                  <WorkspaceNavigationButton
                    label="."
                    detail="root"
                    ariaLabel="Go to workspace root"
                    disabled={disabled}
                    onClick={() => setCurrentPath('')}
                  />
                  <WorkspaceNavigationButton
                    label=".."
                    detail="parent"
                    ariaLabel="Go to parent folder"
                    disabled={disabled}
                    onClick={() => setCurrentPath(parentPath(currentPath))}
                  />
                </>
              ) : null}
              {entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  disabled={disabled}
                  className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-muted/70 disabled:pointer-events-none disabled:opacity-50"
                  onClick={() => setCurrentPath(entry.path)}
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate">{entry.name}</span>
                </button>
              ))}
              {entries.length === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">No child directories</p>
              ) : null}
            </div>
          )}
        </div>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  )
}

function WorkspaceNavigationButton({
  label,
  detail,
  ariaLabel,
  disabled,
  onClick,
}: {
  label: string
  detail: string
  ariaLabel: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-surface-muted/70 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      onClick={onClick}
      aria-label={ariaLabel}
    >
      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
      <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">{detail}</span>
    </button>
  )
}

function WorkspaceHelpTooltip() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Workspace root help"
          >
            <Info className="size-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-72 p-2 leading-relaxed">
          Start Gorchestra with <code className="font-mono">--workspace /path/to/repo</code> to change the base
          workspace. Add more selectable roots with <code className="font-mono">--workspace-root /path</code>.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function workspaceLocation(roots: WorkspaceRoot[], initialPath: string) {
  const normalizedInitial = normalizePath(initialPath)
  const matches = roots
    .map((root) => ({ root, normalized: normalizePath(root.path) }))
    .filter(({ normalized }) => normalizedInitial === normalized || normalizedInitial.startsWith(`${normalized}/`))
    .sort((left, right) => right.normalized.length - left.normalized.length)
  const match = matches[0]
  if (match) {
    return {
      root: match.root,
      relativePath: normalizedInitial.slice(match.normalized.length).replace(/^\/+/, ''),
    }
  }
  return {
    root: roots.find((root) => root.default) ?? roots[0] ?? null,
    relativePath: '',
  }
}

function normalizePath(path: string) {
  return path.trim().replaceAll('\\', '/').replace(/\/+$/, '')
}

function joinWorkspacePath(rootPath: string, relativePath: string) {
  if (!relativePath) return rootPath
  return `${rootPath.replace(/[\\/]$/, '')}/${relativePath}`
}

function parentPath(path: string) {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}
