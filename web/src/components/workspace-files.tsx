import Editor from '@monaco-editor/react'
import {
  Code2,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
  Save,
  Search,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  Session,
  WorkspaceEntry,
  WorkspaceFileContent,
  WorkspaceGitSummary,
  WorkspaceSearchResult,
} from '@/lib/api'
import {
  getSessionFileContent,
  listSessionFiles,
  searchSessionFiles,
  sessionFileRawURL,
  updateSessionFileContent,
  uploadSessionFiles,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type FileSaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'error'
type FileViewMode = 'preview' | 'edit'

export function WorkspaceFilesView({
  session,
  resolvingSessionID = null,
  refreshKey,
  selectedFile,
  resolvedTheme,
  onOpenFile,
  onFileSaved,
  onCloseFile,
  onDirtyChange,
  focusedLine = 0,
}: {
  session: Session | null
  resolvingSessionID?: string | null
  refreshKey: number
  selectedFile: WorkspaceFileContent | null
  resolvedTheme: 'light' | 'dark'
  onOpenFile: (file: WorkspaceFileContent) => void
  onFileSaved: (file: WorkspaceFileContent) => void
  onCloseFile: () => void
  onDirtyChange?: (dirty: boolean) => void
  focusedLine?: number
}) {
  return (
    <section className="relative flex h-full min-h-0 w-full flex-col bg-transparent">
      <div
        className={cn(
          'host-console-frame relative grid min-h-0 flex-1 grid-cols-1 gap-3 p-2 lg:px-3 lg:pb-3',
          selectedFile ? 'lg:grid-cols-1' : 'lg:grid-cols-[minmax(15rem,20rem)_minmax(0,1fr)]',
        )}
      >
        <WorkspaceFileBrowser
          session={session}
          resolvingSessionID={resolvingSessionID}
          refreshKey={refreshKey}
          onOpenFile={onOpenFile}
          selectedFilePath={selectedFile?.path ?? null}
          className={cn('min-h-0', selectedFile && 'hidden')}
        />
        <section
          className={cn(
            'min-h-0 flex-col overflow-hidden rounded-lg border border-border/80 bg-background/72 shadow-sm',
            selectedFile
              ? 'mobile-file-viewer-panel absolute inset-x-2 bottom-2 z-30 flex bg-background shadow-2xl lg:static lg:z-auto lg:bg-background/72 lg:shadow-sm'
              : 'hidden lg:flex',
          )}
        >
          {selectedFile ? (
            <WorkspaceFileContentView
              sessionID={session?.id ?? ''}
              file={selectedFile}
              resolvedTheme={resolvedTheme}
              onFileSaved={onFileSaved}
              onDirtyChange={onDirtyChange}
              onClose={onCloseFile}
              focusedLine={focusedLine}
            />
          ) : (
            <div className="flex h-full min-h-[20rem] flex-col items-center justify-center p-8 text-center">
              <FileText className="mb-3 size-8 text-muted-foreground" aria-hidden="true" />
              <h2 className="text-lg font-semibold">No file selected</h2>
              <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                Choose a workspace file to preview or edit it here.
              </p>
            </div>
          )}
        </section>
      </div>
    </section>
  )
}

export function WorkspaceFileBrowser({
  session,
  resolvingSessionID = null,
  refreshKey,
  onOpenFile = () => undefined,
  selectedFilePath = null,
  className,
}: {
  session: Session | null
  resolvingSessionID?: string | null
  refreshKey: number
  onOpenFile?: (file: WorkspaceFileContent) => void
  selectedFilePath?: string | null
  className?: string
}) {
  const [currentPath, setCurrentPath] = useState('')
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [gitSummary, setGitSummary] = useState<WorkspaceGitSummary | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WorkspaceSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [searching, setSearching] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [error, setError] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const sessionID = session?.id ?? ''
  const displayEntries = query.trim() ? results : entries
  const refreshing = loading || searching
  const isAtWorkspaceRoot = currentPath === ''
  const pathLabel = useMemo(() => basename(currentPath) || 'Workspace', [currentPath])

  function navigateToDirectory(path: string) {
    setCurrentPath(path)
    setQuery('')
    setError('')
  }

  function clearSearch() {
    setQuery('')
    setResults([])
    setSearching(false)
    setError('')
    searchInputRef.current?.focus()
  }

  useEffect(() => {
    setCurrentPath('')
    setEntries([])
    setGitSummary(null)
    setResults([])
    setQuery('')
    setError('')
  }, [sessionID])

  useEffect(() => {
    if (!sessionID) {
      return
    }

    let cancelled = false
    async function loadFiles() {
      setLoading(true)
      setError('')
      try {
        const response = await listSessionFiles(sessionID, currentPath)
        if (cancelled) return
        setEntries(response.entries)
        setGitSummary(response.git_summary ?? null)
      } catch (loadError) {
        if (!cancelled) {
          setEntries([])
          setGitSummary(null)
          setError(loadError instanceof Error ? loadError.message : 'Failed to load files')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadFiles()
    return () => {
      cancelled = true
    }
  }, [currentPath, refreshKey, reloadKey, sessionID])

  useEffect(() => {
    const trimmed = query.trim()
    if (!sessionID || !trimmed) {
      setResults([])
      setSearching(false)
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      async function runSearch() {
        setSearching(true)
        setError('')
        try {
          const response = await searchSessionFiles(sessionID, trimmed, currentPath)
          if (!cancelled) setResults(response.results)
        } catch (searchError) {
          if (!cancelled) {
            setResults([])
            setError(searchError instanceof Error ? searchError.message : 'Failed to search files')
          }
        } finally {
          if (!cancelled) setSearching(false)
        }
      }
      void runSearch()
    }, 220)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [currentPath, query, refreshKey, reloadKey, sessionID])

  async function openEntry(entry: WorkspaceEntry) {
    if (!sessionID) {
      return
    }
    if (entry.type === 'directory') {
      navigateToDirectory(entry.path)
      return
    }

    setLoading(true)
    setError('')
    try {
      const content = await getSessionFileContent(sessionID, entry.path)
      onOpenFile(content)
    } catch (contentError) {
      setError(contentError instanceof Error ? contentError.message : 'Failed to read file')
    } finally {
      setLoading(false)
    }
  }

  async function handleUpload(files: FileList | null) {
    const selectedFiles = files ? Array.from(files) : []
    if (!sessionID || selectedFiles.length === 0) {
      return
    }

    setUploading(true)
    setError('')
    try {
      await uploadSessionFiles(sessionID, selectedFiles, currentPath)
      setQuery('')
      setResults([])
      setReloadKey((value) => value + 1)
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Failed to upload files')
    } finally {
      setUploading(false)
      if (uploadInputRef.current) {
        uploadInputRef.current.value = ''
      }
    }
  }

  return (
    <section
      className={cn(
        'flex h-full min-h-0 flex-col rounded-md border border-border/70 bg-background/46 p-3 shadow-sm',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <SectionTitle icon={Folder} label="Files" />
          <GitSummary summary={gitSummary} />
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            className="sr-only"
            aria-label="Select files to upload"
            disabled={!sessionID || uploading}
            onChange={(event) => void handleUpload(event.target.files)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 border-transparent text-muted-foreground hover:bg-surface-muted/70 hover:text-foreground"
            disabled={!sessionID || loading || uploading}
            onClick={() => uploadInputRef.current?.click()}
            aria-label="Upload files"
            title={`Upload files to ${currentPath || 'workspace root'}`}
          >
            {uploading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Upload aria-hidden="true" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 border-transparent text-muted-foreground hover:bg-surface-muted/70 hover:text-foreground"
            disabled={!sessionID || refreshing || uploading}
            onClick={() => setReloadKey((value) => value + 1)}
            aria-label="Refresh files"
            title="Refresh files"
          >
            {refreshing ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
          </Button>
        </div>
      </div>

      <div className="mt-2 flex h-8 items-center gap-1.5 rounded border border-border/70 bg-background/55 px-2">
        <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          ref={searchInputRef}
          aria-label="Search files and contents"
          value={query}
          disabled={!sessionID}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search files and contents"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
        {searching ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
        {query ? (
          <button
            type="button"
            className="inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-surface-muted/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            disabled={!sessionID}
            onClick={clearSearch}
            aria-label="Clear file search"
            title="Clear file search"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <p className="mt-2 truncate text-[11px] text-muted-foreground" title={session?.workspace_path || undefined}>
        {session ? pathLabel : resolvingSessionID ? 'Loading session' : 'No session selected'}
      </p>

      <div data-testid="workspace-file-scroll-area" className="subtle-scrollbar mt-1 min-h-0 flex-1 overflow-auto">
        {resolvingSessionID && !sessionID ? (
          <LoadingFiles label="Loading session" />
        ) : !sessionID ? (
          <p className="py-3 text-xs text-muted-foreground">Select a session to browse files.</p>
        ) : loading && entries.length === 0 ? (
          <LoadingFiles label="Loading files" />
        ) : (
          <div className="space-y-0.5">
            {!isAtWorkspaceRoot ? (
              <>
                <FileNavigationButton label="." tone="root" onClick={() => navigateToDirectory('')} />
                <FileNavigationButton
                  label=".."
                  tone="parent"
                  onClick={() => navigateToDirectory(parentPath(currentPath))}
                />
              </>
            ) : null}
            {displayEntries.map((entry) => {
              const selected = entry.type === 'file' && selectedFilePath === entry.path
              return (
                <button
                  key={`${entry.type}:${entry.path}`}
                  type="button"
                  className={cn(
                    'flex w-full min-w-0 items-start gap-1.5 rounded px-1.5 py-1 text-left text-xs text-foreground hover:bg-surface-muted/70',
                    selected && 'bg-surface-muted/90 ring-1 ring-border/70',
                  )}
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => void openEntry(entry)}
                >
                  {entry.type === 'directory' ? (
                    <Folder className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  ) : (
                    <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{entry.name}</span>
                    {query.trim() ? <SearchMatchDetail entry={entry} /> : null}
                  </span>
                  {entry.git_status ? <GitStatus status={entry.git_status} /> : null}
                </button>
              )
            })}
            {displayEntries.length === 0 ? (
              <p className="py-3 text-xs text-muted-foreground">{query.trim() ? 'No matches' : 'No files'}</p>
            ) : null}
          </div>
        )}
      </div>

      {error ? <p className="mt-2 shrink-0 text-xs text-destructive">{error}</p> : null}
    </section>
  )
}

export function WorkspaceFileContentView({
  sessionID,
  file,
  resolvedTheme,
  onFileSaved,
  onDirtyChange,
  onClose,
  focusedLine = 0,
}: {
  sessionID: string
  file: WorkspaceFileContent
  resolvedTheme: 'light' | 'dark'
  onFileSaved: (file: WorkspaceFileContent) => void
  onDirtyChange?: (dirty: boolean) => void
  onClose?: () => void
  focusedLine?: number
}) {
  const previewKind = file.preview_kind ?? 'none'
  const mediaPreviewable = previewKind !== 'none'
  const markdown = !mediaPreviewable && file.encoding !== 'binary' && isMarkdownFile(file)
  const editable = !mediaPreviewable && file.encoding === 'utf-8' && !file.truncated
  const textPreviewTruncated = file.encoding !== 'binary' && file.truncated
  const displayPath = file.path || file.name
  const previewURL = sessionID ? sessionFileRawURL(sessionID, file.path) : ''
  const rawURL = sessionID ? sessionFileRawURL(sessionID, file.path, { raw: true }) : ''
  const downloadURL = sessionID ? sessionFileRawURL(sessionID, file.path, { download: true }) : ''
  const [mode, setMode] = useState<FileViewMode>(markdown && focusedLine <= 0 ? 'preview' : 'edit')
  const [draft, setDraft] = useState(file.content)
  const [saveState, setSaveState] = useState<FileSaveState>('clean')
  const [saveError, setSaveError] = useState('')
  const [mediaError, setMediaError] = useState(false)
  const saveResetTimerRef = useRef<number | null>(null)
  const dirty = draft !== file.content

  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])

  const clearSaveResetTimer = useCallback(() => {
    if (saveResetTimerRef.current === null) {
      return
    }
    window.clearTimeout(saveResetTimerRef.current)
    saveResetTimerRef.current = null
  }, [])

  useEffect(() => {
    clearSaveResetTimer()
    setMode(markdown && focusedLine <= 0 ? 'preview' : 'edit')
    setDraft(file.content)
    setSaveState('clean')
    setSaveError('')
    setMediaError(false)
  }, [
    clearSaveResetTimer,
    file.content,
    file.modified_at,
    file.path,
    file.name,
    file.preview_kind,
    focusedLine,
    markdown,
  ])

  useEffect(() => clearSaveResetTimer, [clearSaveResetTimer])

  function handleDraftChange(value: string | undefined) {
    clearSaveResetTimer()
    const nextValue = value ?? ''
    setDraft(nextValue)
    setSaveState(nextValue === file.content ? 'clean' : 'dirty')
    setSaveError('')
  }

  async function handleSave() {
    if (!sessionID || !editable || !dirty || saveState === 'saving') {
      return
    }
    setSaveState('saving')
    setSaveError('')
    try {
      const updated = await updateSessionFileContent(sessionID, file.path, draft)
      onFileSaved(updated)
      setDraft(updated.content)
      setSaveState('saved')
      clearSaveResetTimer()
      saveResetTimerRef.current = window.setTimeout(() => {
        setSaveState('clean')
        saveResetTimerRef.current = null
      }, 1400)
    } catch (saveError) {
      setSaveState('error')
      setSaveError(saveError instanceof Error ? saveError.message : 'Failed to save file')
    }
  }

  return (
    <section role="region" aria-label={`File viewer: ${file.name}`} className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border/70 px-4">
        <div className="flex min-w-0 items-center gap-3">
          <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h2 className="min-w-0 truncate font-mono text-xs font-semibold" title={displayPath}>
            {displayPath}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {rawURL ? (
            <Button asChild size="sm" variant="outline">
              <a
                href={rawURL}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open raw ${file.name} in new tab`}
                title="Open raw file in new tab"
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
                Raw
              </a>
            </Button>
          ) : null}
          {downloadURL ? (
            <Button asChild size="sm" variant="outline">
              <a href={downloadURL} download={file.name} aria-label={`Download ${file.name}`}>
                <Download className="size-3.5" aria-hidden="true" />
                <span className="hidden xl:inline">Download</span>
              </a>
            </Button>
          ) : null}
          {markdown && editable ? (
            <div className="flex items-center rounded-md border border-border/70 bg-background/60 p-0.5">
              <Button
                type="button"
                size="sm"
                variant={mode === 'preview' ? 'secondary' : 'ghost'}
                className="h-7 px-2"
                onClick={() => setMode('preview')}
              >
                <Eye className="size-3.5" aria-hidden="true" />
                Preview
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === 'edit' ? 'secondary' : 'ghost'}
                className="h-7 px-2"
                onClick={() => setMode('edit')}
              >
                <Code2 className="size-3.5" aria-hidden="true" />
                Edit
              </Button>
            </div>
          ) : null}
          {editable ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!dirty || saveState === 'saving' || !sessionID}
              onClick={() => void handleSave()}
            >
              <Save className="size-3.5" aria-hidden="true" />
              {saveState === 'saving' ? 'Saving' : 'Save'}
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground">{formatBytes(file.size_bytes)}</span>
          {onClose ? (
            <button
              type="button"
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Close file viewer"
              onClick={onClose}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>

      <div className={cn('min-h-0 flex-1 p-4', editable && mode === 'edit' ? 'overflow-hidden' : 'overflow-auto')}>
        {mediaPreviewable && previewURL ? (
          mediaError ? (
            <MediaPreviewFallback file={file} />
          ) : (
            <WorkspaceMediaPreview file={file} src={previewURL} onError={() => setMediaError(true)} />
          )
        ) : file.encoding === 'binary' ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No inline preview is available for this file type.
          </div>
        ) : markdown ? (
          mode === 'preview' ? (
            <MarkdownFilePreview content={draft} resolvedTheme={resolvedTheme} />
          ) : (
            <WorkspaceFileEditor
              key={`${file.path}:${focusedLine}`}
              file={file}
              value={draft}
              resolvedTheme={resolvedTheme}
              onChange={handleDraftChange}
              focusedLine={focusedLine}
            />
          )
        ) : editable ? (
          <WorkspaceFileEditor
            key={`${file.path}:${focusedLine}`}
            file={file}
            value={draft}
            resolvedTheme={resolvedTheme}
            onChange={handleDraftChange}
            focusedLine={focusedLine}
          />
        ) : (
          <pre className="min-h-full overflow-auto rounded-md bg-surface-muted/80 p-4 text-xs leading-relaxed text-foreground">
            <code>{file.content}</code>
          </pre>
        )}
      </div>

      {textPreviewTruncated || saveState !== 'clean' ? (
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border/70 px-4 py-2 text-xs text-muted-foreground">
          <span>{textPreviewTruncated ? 'Preview truncated' : saveStatusText(saveState)}</span>
          {saveError ? <span className="text-destructive">{saveError}</span> : null}
        </footer>
      ) : null}
    </section>
  )
}

function WorkspaceMediaPreview({
  file,
  src,
  onError,
}: {
  file: WorkspaceFileContent
  src: string
  onError: () => void
}) {
  switch (file.preview_kind) {
    case 'image':
      return (
        <div className="flex h-full min-h-[12rem] items-center justify-center overflow-auto rounded-md bg-surface-muted/50 p-2">
          <img src={src} alt={file.name} className="max-h-full max-w-full object-contain" onError={onError} />
        </div>
      )
    case 'audio':
      return (
        <div className="flex h-full min-h-[12rem] items-center justify-center rounded-md bg-surface-muted/50 p-6">
          <audio
            src={src}
            controls
            preload="metadata"
            className="w-full max-w-2xl"
            aria-label={`Preview ${file.name}`}
            onError={onError}
          >
            Your browser cannot play this audio file.
          </audio>
        </div>
      )
    case 'video':
      return (
        <div className="flex h-full min-h-[12rem] items-center justify-center overflow-hidden rounded-md bg-black/90 p-2">
          <video
            src={src}
            controls
            preload="metadata"
            className="max-h-full max-w-full"
            aria-label={`Preview ${file.name}`}
            onError={onError}
          >
            Your browser cannot play this video file.
          </video>
        </div>
      )
    case 'pdf':
      return (
        <iframe
          src={src}
          title={`Preview ${file.name}`}
          aria-label={`Preview ${file.name}`}
          className="h-full min-h-[28rem] w-full rounded-md border-0 bg-white"
          onError={onError}
        />
      )
    default:
      return <MediaPreviewFallback file={file} />
  }
}

function MediaPreviewFallback({ file }: { file: WorkspaceFileContent }) {
  return (
    <div role="status" className="flex h-full min-h-[12rem] flex-col items-center justify-center gap-2 text-center">
      <FileText className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium">Preview unavailable in this browser</p>
      <p className="max-w-sm text-xs text-muted-foreground">
        Open the file in a new tab or download it to view {file.media_type || 'this file type'}.
      </p>
    </div>
  )
}

function LoadingFiles({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      {label}
    </div>
  )
}

function FileNavigationButton({ label, tone, onClick }: { label: string; tone: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-surface-muted/70 hover:text-foreground"
      onClick={onClick}
      aria-label={tone === 'root' ? 'Go to workspace root' : 'Go to parent folder'}
    >
      <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
      <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">{tone}</span>
    </button>
  )
}

function SearchMatchDetail({ entry }: { entry: WorkspaceEntry | WorkspaceSearchResult }) {
  const result = entry as WorkspaceSearchResult
  const linePrefix = result.match_type === 'content' && result.line_number ? `:${result.line_number}` : ''
  const detail = result.match_type === 'content' && result.line_text ? result.line_text : entry.path

  return (
    <span className="mt-0.5 block min-w-0 truncate font-mono text-[10px] leading-snug text-muted-foreground">
      {entry.path}
      {linePrefix}
      {result.match_type === 'content' && result.line_text ? ' ' : null}
      {result.match_type === 'content' && result.line_text ? detail : null}
    </span>
  )
}

function GitSummary({ summary }: { summary: WorkspaceGitSummary | null }) {
  if (!summary || (!summary.branch && summary.added + summary.modified + summary.deleted === 0)) {
    return null
  }

  return (
    <div className="flex shrink-0 items-center gap-1" aria-label="Git file summary">
      {summary.branch ? <GitBranchBadge branch={summary.branch} /> : null}
      <GitSummaryBadge label="+" value={summary.added} tone="added" />
      <GitSummaryBadge label="~" value={summary.modified} tone="modified" />
      <GitSummaryBadge label="-" value={summary.deleted} tone="deleted" />
    </div>
  )
}

type GitFileTone = 'added' | 'modified' | 'deleted' | 'neutral'

function GitBranchBadge({ branch }: { branch: string }) {
  return (
    <span className="git-file-tag git-file-tag--neutral git-file-tag--branch" title={`Git branch: ${branch}`}>
      {branch}
    </span>
  )
}

function GitSummaryBadge({ label, value, tone }: { label: string; value: number; tone: GitFileTone }) {
  if (value === 0) {
    return null
  }

  return (
    <span className={cn('git-file-tag', gitFileToneClassName(tone))} title={`${gitSummaryLabel(label)}: ${value}`}>
      {label}
      {value}
    </span>
  )
}

function GitStatus({ status }: { status: string }) {
  return (
    <span className={cn('git-file-tag shrink-0 uppercase', gitStatusClassName(status))} title={`Git: ${status}`}>
      {gitStatusLabel(status)}
    </span>
  )
}

function SectionTitle({ icon: Icon, label }: { icon: typeof Folder; label: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
      <Icon className="size-3.5" aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}

function WorkspaceFileEditor({
  file,
  value,
  resolvedTheme,
  onChange,
  focusedLine = 0,
}: {
  file: WorkspaceFileContent
  value: string
  resolvedTheme: 'light' | 'dark'
  onChange: (value: string | undefined) => void
  focusedLine?: number
}) {
  return (
    <div className="h-full min-h-[320px] overflow-hidden rounded-md border border-border/70 bg-background">
      <Editor
        height="100%"
        path={file.path || file.name}
        language={editorLanguageForFile(file)}
        theme={resolvedTheme === 'dark' ? 'vs-dark' : 'light'}
        value={value}
        onChange={onChange}
        onMount={(editor) => {
          if (focusedLine <= 0) return
          const line = Math.min(focusedLine, editor.getModel()?.getLineCount() ?? focusedLine)
          editor.setPosition({ lineNumber: line, column: 1 })
          editor.revealLineInCenter(line)
          editor.focus()
        }}
        options={{
          automaticLayout: true,
          fontSize: 13,
          lineNumbersMinChars: 3,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
        }}
      />
    </div>
  )
}

function MarkdownFilePreview({ content, resolvedTheme }: { content: string; resolvedTheme: 'light' | 'dark' }) {
  return (
    <article className="mx-auto min-h-full max-w-3xl rounded-md bg-background/72 px-6 py-5 text-sm leading-7 text-foreground shadow-sm ring-1 ring-border/60">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="mb-4 mt-0 text-2xl font-semibold leading-tight">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-3 mt-7 text-xl font-semibold leading-tight">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 mt-6 text-base font-semibold leading-tight">{children}</h3>,
          p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-4 border-l-2 border-border pl-4 text-muted-foreground">{children}</blockquote>
          ),
          code: (props) => <MarkdownPreviewCode {...props} resolvedTheme={resolvedTheme} />,
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => (
            <div className="my-4 overflow-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-medium">{children}</th>,
          td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
          hr: () => <hr className="my-6 border-border" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
  )
}

function MarkdownPreviewCode({
  children,
  className,
  resolvedTheme,
}: ComponentProps<'code'> & { resolvedTheme: 'light' | 'dark' }) {
  if (className?.split(/\s+/).some((name) => name.toLowerCase() === 'language-mermaid')) {
    return <MermaidDiagram source={String(children ?? '').replace(/\n$/, '')} resolvedTheme={resolvedTheme} />
  }

  const block = className?.startsWith('language-') || String(children ?? '').includes('\n')
  if (block) {
    return (
      <code className="my-4 block overflow-auto rounded-md bg-surface-muted p-3 font-mono text-xs leading-relaxed">
        {children}
      </code>
    )
  }
  return <code className="rounded bg-surface-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
}

type MermaidRenderState =
  { status: 'loading' } | { status: 'rendered'; svg: string } | { status: 'error'; message: string }

let mermaidRenderCounter = 0
let mermaidRenderQueue = Promise.resolve()

function MermaidDiagram({ source, resolvedTheme }: { source: string; resolvedTheme: 'light' | 'dark' }) {
  const [state, setState] = useState<MermaidRenderState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })

    void renderMermaidDiagram(source, resolvedTheme).then(
      (svg) => {
        if (!cancelled) setState({ status: 'rendered', svg })
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: mermaidErrorMessage(error) })
      },
    )

    return () => {
      cancelled = true
    }
  }, [resolvedTheme, source])

  if (state.status === 'loading') {
    return (
      <div className="my-4 flex min-h-28 items-center justify-center rounded-md border border-border/70 bg-surface-muted/40 text-xs text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
        Rendering diagram
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="my-4 overflow-hidden rounded-md border border-destructive/50 bg-destructive/5">
        <p role="alert" className="m-0 border-b border-destructive/30 px-3 py-2 text-xs text-destructive">
          Unable to render Mermaid diagram: {state.message}
        </p>
        <pre className="m-0 overflow-auto p-3 font-mono text-xs leading-relaxed">
          <code>{source}</code>
        </pre>
      </div>
    )
  }

  return (
    <div
      role="img"
      aria-label="Mermaid diagram"
      className="my-4 overflow-auto rounded-md border border-border/70 bg-surface-muted/25 p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  )
}

function renderMermaidDiagram(source: string, resolvedTheme: 'light' | 'dark') {
  const render = async () => {
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: resolvedTheme === 'dark' ? 'dark' : 'default',
    })
    const id = `gorchestra-mermaid-${++mermaidRenderCounter}`
    const { svg } = await mermaid.render(id, source)
    return svg
  }

  const result = mermaidRenderQueue.then(render, render)
  mermaidRenderQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function mermaidErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim()
  }
  return 'Unknown rendering error'
}

function gitSummaryLabel(label: string) {
  switch (label) {
    case '+':
      return 'Added'
    case '~':
      return 'Modified'
    case '-':
      return 'Deleted'
    default:
      return label
  }
}

function gitStatusClassName(status: string) {
  switch (status) {
    case 'modified':
      return gitFileToneClassName('modified')
    case 'added':
    case 'untracked':
      return gitFileToneClassName('added')
    case 'deleted':
    case 'conflicted':
      return gitFileToneClassName('deleted')
    default:
      return gitFileToneClassName('neutral')
  }
}

function gitFileToneClassName(tone: GitFileTone) {
  switch (tone) {
    case 'added':
      return 'git-file-tag--added'
    case 'modified':
      return 'git-file-tag--modified'
    case 'deleted':
      return 'git-file-tag--deleted'
    default:
      return 'git-file-tag--neutral'
  }
}

function gitStatusLabel(status: string) {
  switch (status) {
    case 'modified':
      return 'M'
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'untracked':
      return '?'
    case 'conflicted':
      return '!'
    case 'renamed':
      return 'R'
    default:
      return status.slice(0, 1)
  }
}

function basename(path: string) {
  const parts = path.split('/').filter(Boolean)
  return parts.at(-1) ?? ''
}

function parentPath(path: string) {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

function isMarkdownFile(file: WorkspaceFileContent) {
  const name = `${file.path || file.name}`.toLowerCase()
  return name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.mdown') || name.endsWith('.mdx')
}

function saveStatusText(state: FileSaveState) {
  switch (state) {
    case 'dirty':
      return 'Unsaved changes'
    case 'saving':
      return 'Saving changes'
    case 'saved':
      return 'Saved'
    case 'error':
      return 'Save failed'
    default:
      return ''
  }
}

function editorLanguageForFile(file: WorkspaceFileContent) {
  const name = `${file.path || file.name}`.toLowerCase()
  if (name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.mdown')) return 'markdown'
  if (name.endsWith('.mdx')) return 'mdx'
  if (name.endsWith('.ts') || name.endsWith('.tsx')) return 'typescript'
  if (name.endsWith('.js') || name.endsWith('.jsx') || name.endsWith('.mjs') || name.endsWith('.cjs'))
    return 'javascript'
  if (name.endsWith('.json')) return 'json'
  if (name.endsWith('.go')) return 'go'
  if (name.endsWith('.css')) return 'css'
  if (name.endsWith('.html') || name.endsWith('.htm')) return 'html'
  if (name.endsWith('.yml') || name.endsWith('.yaml')) return 'yaml'
  if (name.endsWith('.sh') || name.endsWith('.bash') || name.endsWith('.zsh')) return 'shell'
  if (name.endsWith('.sql')) return 'sql'
  if (name.endsWith('.toml')) return 'toml'
  return 'plaintext'
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}
