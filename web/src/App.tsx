import Editor from '@monaco-editor/react'
import { Code2, Eye, FileText, Menu, MessageSquare, Plus, Save, Terminal, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'
import type {
  AgentEvent,
  AgentType,
  MessageAttachment,
  Session,
  SessionAgentOptions,
  SessionStatus,
  SubmitAgentOptions,
  UserInputAnswers,
  WorkspaceFileContent,
} from '@/lib/api'
import {
  APIError,
  answerUserInput,
  archiveSession,
  cancelSession,
  clearSession,
  compactSession,
  createSession,
  fetchHealth,
  getSession,
  getSessionFileContent,
  listSessions,
  restoreSession,
  sessionActivityStreamURL,
  submitMessage,
  updateSessionAgentOptions,
  updateSessionFileContent,
  updateSessionTitle,
} from '@/lib/api'
import { isTerminalEvent, knownEventTypes, lastSeq, shouldRefreshWorkspaceFilesForEvent, statusFromEvent } from '@/lib/events'
import { nextSessionIDAfterArchive } from '@/lib/sessions'
import { useSessionEvents } from '@/hooks/use-session-events'
import { useFavicon } from '@/hooks/use-favicon'
import { useTheme } from '@/hooks/use-theme'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { CreateSessionDialog } from '@/components/create-session-dialog'
import { HostConsole } from '@/components/host-console'
import { RunHealthRail } from '@/components/run-health-rail'
import { SessionDetail } from '@/components/session-detail'
import { defaultSessionListFilters, SessionList, type SessionListFilters } from '@/components/session-list'
import { StatusBadge } from '@/components/status-badge'
import { hasSessionAttention, latestSessionSeq } from '@/lib/session-attention'
import { sessionIDFromPathname, sessionPath } from '@/lib/routes'
import { cn } from '@/lib/utils'

type HealthState = 'checking' | 'online' | 'offline'
type SessionRouteHistoryMode = 'push' | 'replace' | 'none'
type PaneSide = 'left' | 'right'
type PaneWidths = {
  left: number
  right: number
}
type FileOverlayMode = 'preview' | 'edit'
type FileSaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'error'
type CodexSessionAction = 'clear' | 'compact'
type AppView = 'session' | 'console'
type PendingSessionAction = {
  action: CodexSessionAction
  sessionID: string
}
type PendingSessionNavigation = {
  targetSessionID: string | null
  historyMode: SessionRouteHistoryMode
}

const debugStorageKeyPrefix = 'gorchestra.session-debug.'
const paneWidthsStorageKey = 'gorchestra.pane-widths.v1'
const sessionSeenSeqStorageKey = 'gorchestra.session-seen-seq.v1'
const defaultPaneWidths: PaneWidths = { left: 348, right: 344 }
const paneLimits = {
  leftMin: 224,
  leftMax: 560,
  rightMin: 300,
  rightMax: 640,
  centerMin: 520,
}

function App() {
  const [healthState, setHealthState] = useState<HealthState>('checking')
  const [sessions, setSessions] = useState<Session[]>([])
  const [selectedSessionID, setSelectedSessionID] = useState<string | null>(() => selectedSessionIDFromLocation())
  const [createOpen, setCreateOpen] = useState(false)
  const [mobileListOpen, setMobileListOpen] = useState(false)
  const [loadingSessions, setLoadingSessions] = useState(true)
  const [refreshingSessions, setRefreshingSessions] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showDebugEvents, setShowDebugEvents] = useState(false)
  const [archivingSessionID, setArchivingSessionID] = useState<string | null>(null)
  const [confirmArchiveSessionID, setConfirmArchiveSessionID] = useState<string | null>(null)
  const [confirmSessionAction, setConfirmSessionAction] = useState<PendingSessionAction | null>(null)
  const [confirmSessionNavigation, setConfirmSessionNavigation] = useState<PendingSessionNavigation | null>(null)
  const [pendingSessionAction, setPendingSessionAction] = useState<PendingSessionAction | null>(null)
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(() => loadPaneWidths())
  const [openWorkspaceFile, setOpenWorkspaceFile] = useState<WorkspaceFileContent | null>(null)
  const [fileRefreshKey, setFileRefreshKey] = useState(0)
  const [eventRefreshKey, setEventRefreshKey] = useState(0)
  const [followingLatest, setFollowingLatest] = useState(true)
  const [lastSeenSeqBySession, setLastSeenSeqBySession] = useState<Record<string, number>>(() => loadSessionSeenSeqs())
  const [titleEditorStates, setTitleEditorStates] = useState<Record<string, { editing: boolean; dirty: boolean }>>({})
  const [sessionSearchQuery, setSessionSearchQuery] = useState('')
  const [sessionListFilters, setSessionListFilters] = useState<SessionListFilters>(defaultSessionListFilters)
  const [appView, setAppView] = useState<AppView>('session')
  const selectedSessionIDRef = useRef<string | null>(selectedSessionID)
  const sessionsRef = useRef<Session[]>([])
  const paneWidthsRef = useRef(paneWidths)

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionID) ?? null,
    [selectedSessionID, sessions],
  )
  const hasFaviconAttention = useMemo(
    () => hasSessionAttention(sessions, lastSeenSeqBySession),
    [lastSeenSeqBySession, sessions],
  )
  const hasOpenTitleEdit = useMemo(
    () => Object.values(titleEditorStates).some((state) => state.editing),
    [titleEditorStates],
  )
  const hasDirtyTitleEdit = useMemo(
    () => Object.values(titleEditorStates).some((state) => state.editing && state.dirty),
    [titleEditorStates],
  )
  const theme = useTheme()
  useFavicon(hasFaviconAttention)

  const applySession = useCallback((session: Session) => {
    setSessions((current) => {
      if (session.archived_at && !sessionListFilters.includeArchived) {
        return current.filter((item) => item.id !== session.id)
      }
      return sortSessions([session, ...current.filter((item) => item.id !== session.id)])
    })
  }, [sessionListFilters.includeArchived])

  const selectSession = useCallback((sessionID: string | null, historyMode: SessionRouteHistoryMode = 'push') => {
    selectedSessionIDRef.current = sessionID
    setSelectedSessionID(sessionID)
    if (historyMode !== 'none') {
      writeSelectedSessionRoute(sessionID, historyMode)
    }
  }, [])

  const completeSessionSelection = useCallback(
    (sessionID: string | null, historyMode: SessionRouteHistoryMode = 'push') => {
      selectSession(sessionID, historyMode)
      setMobileListOpen(false)
      setNotice('')
    },
    [selectSession],
  )

  const requestSessionSelection = useCallback(
    (sessionID: string | null, historyMode: SessionRouteHistoryMode = 'push') => {
      if (sessionID === selectedSessionIDRef.current) {
        return
      }
      if (hasOpenTitleEdit) {
        setConfirmSessionNavigation({ targetSessionID: sessionID, historyMode })
        return
      }
      completeSessionSelection(sessionID, historyMode)
    },
    [completeSessionSelection, hasOpenTitleEdit],
  )

  const refreshSession = useCallback(
    async (sessionID: string) => {
      const session = await getSession(sessionID)
      applySession(session)
      return session
    },
    [applySession],
  )

  const markSessionSeen = useCallback((sessionID: string, seq: number) => {
    if (!sessionID || seq <= 0) {
      return
    }
    setLastSeenSeqBySession((current) => {
      if ((current[sessionID] ?? 0) >= seq) {
        return current
      }
      const next = { ...current, [sessionID]: seq }
      saveSessionSeenSeqs(next)
      return next
    })
  }, [])

  const markSessionUnseenAfter = useCallback((sessionID: string, seq: number) => {
    if (!sessionID || seq <= 0) {
      return
    }
    setLastSeenSeqBySession((current) => {
      const unseenSeq = Math.max(0, seq - 1)
      if ((current[sessionID] ?? 0) <= unseenSeq) {
        return current
      }
      const next = { ...current }
      if (unseenSeq > 0) {
        next[sessionID] = unseenSeq
      } else {
        delete next[sessionID]
      }
      saveSessionSeenSeqs(next)
      return next
    })
  }, [])

  useEffect(() => {
    selectedSessionIDRef.current = selectedSessionID
  }, [selectedSessionID])

  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  useEffect(() => {
    paneWidthsRef.current = paneWidths
    savePaneWidths(paneWidths)
  }, [paneWidths])

  useEffect(() => {
    function handlePopState() {
      requestSessionSelection(selectedSessionIDFromLocation(), 'none')
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [requestSessionSelection])

  useEffect(() => {
    setShowDebugEvents(loadSessionDebugPreference(selectedSessionID))
    setOpenWorkspaceFile(null)
    setFollowingLatest(true)
  }, [selectedSessionID])

  useEffect(() => {
    setTitleEditorStates({})
  }, [selectedSessionID])

  const applySessionActivityEvent = useCallback(
    (event: AgentEvent) => {
      const status = statusFromEvent(event)
      setSessions((current) =>
        sortSessions(
          current.map((session) =>
            session.id === event.session_id ? applySessionEvent(session, event, status) : session,
          ),
        ),
      )
    },
    [],
  )

  const handleSessionEvent = useCallback(
    (event: AgentEvent) => {
      applySessionActivityEvent(event)
      if (shouldRefreshWorkspaceFilesForEvent(event) && event.session_id === selectedSessionIDRef.current) {
        setFileRefreshKey((value) => value + 1)
      }
      if (isTerminalEvent(event.type)) {
        window.setTimeout(() => {
          void refreshSession(event.session_id)
        }, 250)
      }
    },
    [applySessionActivityEvent, refreshSession],
  )

  const handleActivityEvent = useCallback(
    (event: AgentEvent) => {
      applySessionActivityEvent(event)
      const knownSession = sessionsRef.current.find((session) => session.id === event.session_id)
      const terminalUnselected = isTerminalEvent(event.type) && event.session_id !== selectedSessionIDRef.current
      if (terminalUnselected && event.seq >= latestSessionSeq(knownSession ?? null)) {
        markSessionUnseenAfter(event.session_id, event.seq)
      }
      if (!knownSession || terminalUnselected) {
        window.setTimeout(() => {
          void refreshSession(event.session_id)
        }, 250)
      }
    },
    [applySessionActivityEvent, markSessionUnseenAfter, refreshSession],
  )

  const {
    events,
    streamState,
    error: streamError,
    hasOlderEvents,
    loadingOlderEvents,
    loadOlderEvents,
  } = useSessionEvents(selectedSessionID, {
    onEvent: handleSessionEvent,
    followLatest: followingLatest,
    refreshKey: eventRefreshKey,
  })

  useEffect(() => {
    if (!selectedSessionID) {
      return
    }
    markSessionSeen(selectedSessionID, Math.max(lastSeq(events), latestSessionSeq(selectedSession)))
  }, [events, markSessionSeen, selectedSession, selectedSessionID])

  const loadSessions = useCallback(async (options: { showLoading?: boolean } = {}) => {
    const showLoading = options.showLoading ?? sessionsRef.current.length === 0
    if (showLoading) {
      setLoadingSessions(true)
      setError('')
    } else {
      setRefreshingSessions(true)
    }
    try {
      const nextSessions = await listSessions({ include_archived: sessionListFilters.includeArchived })
      const selectedID = selectedSessionIDRef.current
      const mergedSessions = await includeSelectedSession(
        nextSessions,
        selectedID,
        sessionListFilters.includeArchived,
      )
      const nextSelectedID =
        selectedID && mergedSessions.some((session) => session.id === selectedID)
          ? selectedID
          : (nextSessions[0]?.id ?? mergedSessions[0]?.id ?? null)

      setSessions(sortSessions(mergedSessions))
      selectSession(nextSelectedID, 'replace')
    } catch (loadError) {
      if (showLoading) {
        setError(messageFromError(loadError))
      }
    } finally {
      if (showLoading) {
        setLoadingSessions(false)
      } else {
        setRefreshingSessions(false)
      }
    }
  }, [selectSession, sessionListFilters.includeArchived])

  useEffect(() => {
    let closed = false
    let source: EventSource | null = null
    let reconnectTimer: number | undefined

    function closeSource() {
      source?.close()
      source = null
    }

    function handleActivityMessage(message: MessageEvent<string>) {
      try {
        handleActivityEvent(JSON.parse(message.data) as AgentEvent)
      } catch {
        // A malformed sidebar event should not interrupt the selected transcript stream.
      }
    }

    function connect() {
      if (closed) {
        return
      }
      source = new EventSource(sessionActivityStreamURL())
      source.onerror = () => {
        if (closed) {
          return
        }
        closeSource()
        reconnectTimer = window.setTimeout(() => {
          void loadSessions({ showLoading: false }).finally(connect)
        }, 1000)
      }
      for (const eventType of knownEventTypes) {
        source.addEventListener(eventType, handleActivityMessage)
      }
    }

    connect()

    return () => {
      closed = true
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer)
      }
      closeSource()
    }
  }, [handleActivityEvent, loadSessions])

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  useEffect(() => {
    let cancelled = false
    async function check() {
      try {
        await fetchHealth()
        if (!cancelled) setHealthState('online')
      } catch {
        if (!cancelled) setHealthState('offline')
      }
    }
    void check()
    const timer = window.setInterval(() => void check(), 15000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!selectedSessionID) {
      return
    }
    void refreshSession(selectedSessionID).catch((refreshError) => {
      setError(messageFromError(refreshError))
    })
  }, [refreshSession, selectedSessionID])

  async function handleCreate(params: {
    agent_type: AgentType
    title?: string
    workspace_path?: string
    agent_options?: SessionAgentOptions
  }) {
    const session = await createSession(params)
    applySession(session)
    selectSession(session.id, 'push')
    setNotice('')
    return session
  }

  async function handleSubmitPrompt(
    content: string,
    agentOptions?: SubmitAgentOptions,
    attachments: MessageAttachment[] = [],
    queue = false,
  ) {
    if (!selectedSessionID) {
      throw new Error('Select a session first.')
    }
    const response = await submitMessage(selectedSessionID, content, agentOptions, attachments, queue)
    setSessions((current) =>
      current.map((session) =>
        session.id === selectedSessionID
          ? {
              ...session,
              status: response.status,
              completed_at: response.status === 'running' ? null : session.completed_at,
            }
          : session,
      ),
    )
    setNotice('')
    setEventRefreshKey((value) => value + 1)
  }

  async function handleCancel() {
    if (!selectedSessionID) {
      return
    }
    try {
      await cancelSession(selectedSessionID)
      setNotice('Cancellation requested.')
    } catch (cancelError) {
      setError(messageFromError(cancelError))
      if (cancelError instanceof APIError && cancelError.status === 409) {
        await refreshSession(selectedSessionID)
      }
    }
  }

  async function handleAnswerUserInput(requestID: string, answers: UserInputAnswers) {
    if (!selectedSessionID) {
      throw new Error('Select a session first.')
    }
    await answerUserInput(selectedSessionID, requestID, answers)
    setNotice('')
  }

  function handleShowDebugEventsChange(nextShowDebugEvents: boolean) {
    setShowDebugEvents(nextShowDebugEvents)
    saveSessionDebugPreference(selectedSessionID, nextShowDebugEvents)
  }

  const handleTitleEditStateChange = useCallback(
    ({
      editorID,
      editing,
      dirty,
    }: {
      editorID: string
      editing: boolean
      dirty: boolean
    }) => {
      setTitleEditorStates((current) => {
        if (!editing && !dirty) {
          if (!(editorID in current)) {
            return current
          }
          const next = { ...current }
          delete next[editorID]
          return next
        }
        const existing = current[editorID]
        if (existing?.editing === editing && existing.dirty === dirty) {
          return current
        }
        return { ...current, [editorID]: { editing, dirty } }
      })
    },
    [],
  )

  async function handleUpdateTitle(title: string) {
    if (!selectedSessionID) {
      return
    }
    const updated = await updateSessionTitle(selectedSessionID, title)
    applySession(updated)
  }

  async function handleUpdateAgentOptions(agentOptions: SessionAgentOptions) {
    if (!selectedSessionID) {
      return
    }
    try {
      const updated = await updateSessionAgentOptions(selectedSessionID, agentOptions)
      applySession(updated)
      setError('')
    } catch (optionsError) {
      setError(messageFromError(optionsError))
    }
  }

  function requestArchiveSession() {
    if (!selectedSessionID) {
      return
    }
    setConfirmArchiveSessionID(selectedSessionID)
  }

  async function handleConfirmArchiveSession() {
    if (!confirmArchiveSessionID) {
      return
    }

    const sessionID = confirmArchiveSessionID
    const targetSession = sessions.find((session) => session.id === sessionID) ?? null
    const restoring = Boolean(targetSession?.archived_at)
    const nextSelectedID = sessionListFilters.includeArchived
      ? selectedSessionID
      : nextSessionIDAfterArchive(sessions, sessionID, selectedSessionID)
    setArchivingSessionID(sessionID)
    setError('')
    try {
      const updatedSession = restoring ? await restoreSession(sessionID) : await archiveSession(sessionID)
      applySession(updatedSession)
      selectSession(restoring ? sessionID : nextSelectedID, 'replace')
      setNotice('')
      setConfirmArchiveSessionID(null)
    } catch (archiveError) {
      setError(messageFromError(archiveError))
      if (archiveError instanceof APIError && archiveError.status === 409) {
        await refreshSession(sessionID)
      }
    } finally {
      setArchivingSessionID((current) => (current === sessionID ? null : current))
    }
  }

  function requestSessionAction(action: CodexSessionAction) {
    if (!selectedSessionID) {
      return
    }
    setConfirmSessionAction({ action, sessionID: selectedSessionID })
  }

  async function handleConfirmSessionAction() {
    if (!confirmSessionAction) {
      return
    }

    const { action, sessionID } = confirmSessionAction
    setPendingSessionAction({ action, sessionID })
    setError('')
    try {
      const response = action === 'clear' ? await clearSession(sessionID) : await compactSession(sessionID)
      setSessions((current) =>
        current.map((session) =>
          session.id === sessionID
            ? {
                ...session,
                status: response.status,
                provider_session_id: action === 'clear' ? undefined : session.provider_session_id,
                completed_at: response.status === 'running' ? null : session.completed_at,
              }
            : session,
        ),
      )
      if (action === 'clear') {
        await refreshSession(sessionID)
      }
      setNotice(action === 'clear' ? 'Context cleared.' : 'Compaction started.')
      setConfirmSessionAction(null)
    } catch (actionError) {
      setError(messageFromError(actionError))
      if (actionError instanceof APIError && actionError.status === 409) {
        await refreshSession(sessionID)
      }
    } finally {
      setPendingSessionAction((current) =>
        current?.action === action && current.sessionID === sessionID ? null : current,
      )
    }
  }

  function handleRefresh() {
    void loadSessions()
    if (selectedSessionID) void refreshSession(selectedSessionID)
  }

  const handleOpenWorkspacePath = useCallback(
    async (path: string) => {
      if (!selectedSessionID || !selectedSession) {
        return
      }

      setError('')
      try {
        const content = await getSessionFileContent(
          selectedSessionID,
          workspaceRelativeFilePath(path, selectedSession.workspace_path),
        )
        setOpenWorkspaceFile(content)
      } catch (openError) {
        setError(messageFromError(openError))
      }
    },
    [selectedSession, selectedSessionID],
  )

  function beginPaneResize(side: PaneSide, event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) {
      return
    }
    event.preventDefault()

    const startX = event.clientX
    const startWidths = paneWidthsRef.current
    const previousCursor = document.documentElement.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.documentElement.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    function handlePointerMove(moveEvent: PointerEvent) {
      const delta = moveEvent.clientX - startX
      const nextWidths =
        side === 'left'
          ? { ...startWidths, left: startWidths.left + delta }
          : { ...startWidths, right: startWidths.right - delta }
      setPaneWidths(clampPaneWidths(nextWidths, side))
    }

    function handlePointerUp() {
      document.documentElement.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
  }

  function handlePaneResizeKey(side: PaneSide, event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.shiftKey ? 48 : 16
    let direction = 0
    if (event.key === 'ArrowLeft') direction = side === 'left' ? -1 : 1
    if (event.key === 'ArrowRight') direction = side === 'left' ? 1 : -1
    if (direction === 0) {
      return
    }

    event.preventDefault()
    setPaneWidths((current) =>
      clampPaneWidths(
        {
          ...current,
          [side]: current[side] + direction * step,
        },
        side,
      ),
    )
  }

  const sessionListProps = {
    sessions,
    selectedSessionID,
    lastSeenSeqBySession,
    loading: loadingSessions || refreshingSessions,
    query: sessionSearchQuery,
    onQueryChange: setSessionSearchQuery,
    filters: sessionListFilters,
    onFiltersChange: setSessionListFilters,
    onSelect: (sessionID: string) => requestSessionSelection(sessionID, 'push'),
    onCreate: () => setCreateOpen(true),
    themePreference: theme.preference,
    resolvedTheme: theme.resolvedTheme,
    onThemeToggle: theme.nextPreference,
  }
  const list = <SessionList {...sessionListProps} />
  const mobileList = <SessionList {...sessionListProps} variant="embedded" />
  const confirmActionPending =
    pendingSessionAction !== null &&
    confirmSessionAction !== null &&
    pendingSessionAction.sessionID === confirmSessionAction.sessionID &&
    pendingSessionAction.action === confirmSessionAction.action
  const confirmArchiveSession = confirmArchiveSessionID
    ? (sessions.find((session) => session.id === confirmArchiveSessionID) ?? null)
    : null
  const confirmArchivePending =
    confirmArchiveSessionID !== null && archivingSessionID === confirmArchiveSessionID
  const navigationTargetSession = confirmSessionNavigation?.targetSessionID
    ? (sessions.find((session) => session.id === confirmSessionNavigation.targetSessionID) ?? null)
    : null
  const viewToggle = (
    <div className="relative grid shrink-0 grid-cols-2 rounded-md bg-muted p-1 shadow-inner">
      <span
        aria-hidden="true"
        className={cn(
          'absolute bottom-1 left-1 top-1 w-9 rounded-sm bg-background shadow-sm transition-transform duration-150 ease-out',
          appView === 'console' ? 'translate-x-9' : 'translate-x-0',
        )}
      />
      <button
        type="button"
        aria-label="Show chat"
        aria-pressed={appView === 'session'}
        className={cn(
          'relative z-10 flex h-8 w-9 items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          appView === 'session' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
        onClick={() => setAppView('session')}
      >
        <MessageSquare className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Show console"
        aria-pressed={appView === 'console'}
        className={cn(
          'relative z-10 flex h-8 w-9 items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          appView === 'console' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
        onClick={() => setAppView('console')}
      >
        <Terminal className="size-4" />
      </button>
    </div>
  )

  return (
    <main className="app-shell">
      <div className="hidden min-h-0 shrink-0 lg:flex" style={paneWidthStyle(paneWidths.left)}>
        {list}
      </div>

      <PaneResizeHandle
        label="Resize sessions pane"
        value={paneWidths.left}
        min={paneLimits.leftMin}
        max={paneLimits.leftMax}
        onPointerDown={(event) => beginPaneResize('left', event)}
        onKeyDown={(event) => handlePaneResizeKey('left', event)}
      />

      <section className="command-workspace flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b bg-background/84 px-3 lg:hidden">
          <Sheet open={mobileListOpen} onOpenChange={setMobileListOpen}>
            <SheetTrigger asChild>
              <Button size="icon" variant="outline" aria-label="Open sessions" className="lg:hidden">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Sessions</SheetTitle>
              </SheetHeader>
              <div className="min-h-0 flex-1">{mobileList}</div>
            </SheetContent>
          </Sheet>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {selectedSession ? <StatusBadge status={selectedSession.status} /> : null}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{selectedSession?.title || 'Gorchestra'}</p>
              <p className="truncate text-xs text-muted-foreground">{selectedSession?.agent_type || 'No session'}</p>
            </div>
          </div>
          <Button size="icon" onClick={() => setCreateOpen(true)} aria-label="Create session">
            <Plus />
          </Button>
        </header>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          {appView === 'console' ? (
            <HostConsole
              session={selectedSession}
              resolvedTheme={theme.resolvedTheme}
              headerActions={viewToggle}
              onUpdateTitle={handleUpdateTitle}
              onTitleEditStateChange={handleTitleEditStateChange}
            />
          ) : (
            <SessionDetail
              session={selectedSession}
              events={events}
              streamState={streamState}
              streamError={streamError}
              hasOlderEvents={hasOlderEvents}
              loadingOlderEvents={loadingOlderEvents}
              onLoadOlderEvents={loadOlderEvents}
              onFollowLatestChange={setFollowingLatest}
              errorMessage={error || streamError}
              notice={notice || healthLabel(healthState)}
              showDebugEvents={showDebugEvents}
              onShowDebugEventsChange={handleShowDebugEventsChange}
              onSubmitPrompt={handleSubmitPrompt}
              onAnswerUserInput={handleAnswerUserInput}
              onCancel={handleCancel}
              onUpdateTitle={handleUpdateTitle}
              onTitleEditStateChange={handleTitleEditStateChange}
              onUpdateAgentOptions={handleUpdateAgentOptions}
              onRefresh={handleRefresh}
              onOpenFilePath={handleOpenWorkspacePath}
              onErrorMessageChange={setError}
              headerActions={viewToggle}
            />
          )}
          {appView === 'session' && openWorkspaceFile ? (
            <WorkspaceFileOverlay
              sessionID={selectedSessionID ?? ''}
              file={openWorkspaceFile}
              resolvedTheme={theme.resolvedTheme}
              onFileSaved={setOpenWorkspaceFile}
              onClose={() => setOpenWorkspaceFile(null)}
            />
          ) : null}
        </div>
      </section>

      <PaneResizeHandle
        label="Resize details pane"
        value={paneWidths.right}
        min={paneLimits.rightMin}
        max={paneLimits.rightMax}
        onPointerDown={(event) => beginPaneResize('right', event)}
        onKeyDown={(event) => handlePaneResizeKey('right', event)}
      />

      <div className="hidden min-h-0 shrink-0 lg:flex" style={paneWidthStyle(paneWidths.right)}>
        <RunHealthRail
          session={selectedSession}
          events={events}
          streamState={streamState}
          streamError={streamError}
          fileRefreshKey={fileRefreshKey}
          onClear={() => {
            requestSessionAction('clear')
            return Promise.resolve()
          }}
          onCompact={() => {
            requestSessionAction('compact')
            return Promise.resolve()
          }}
          onToggleArchive={() => {
            requestArchiveSession()
            return Promise.resolve()
          }}
          onOpenFile={setOpenWorkspaceFile}
          clearPending={
            selectedSession
              ? pendingSessionAction?.sessionID === selectedSession.id && pendingSessionAction.action === 'clear'
              : false
          }
          compactPending={
            selectedSession
              ? pendingSessionAction?.sessionID === selectedSession.id && pendingSessionAction.action === 'compact'
              : false
          }
          archivePending={selectedSession ? archivingSessionID === selectedSession.id : false}
        />
      </div>

      <SessionActionConfirmDialog
        request={confirmSessionAction}
        session={
          confirmSessionAction
            ? (sessions.find((session) => session.id === confirmSessionAction.sessionID) ?? null)
            : null
        }
        pending={confirmActionPending}
        onOpenChange={(open) => {
          if (!open && !pendingSessionAction) {
            setConfirmSessionAction(null)
          }
        }}
        onConfirm={() => void handleConfirmSessionAction()}
      />
      <ArchiveSessionConfirmDialog
        session={confirmArchiveSession}
        pending={confirmArchivePending}
        onOpenChange={(open) => {
          if (!open && !archivingSessionID) {
            setConfirmArchiveSessionID(null)
          }
        }}
        onConfirm={() => void handleConfirmArchiveSession()}
      />
      <SessionNavigationConfirmDialog
        currentSession={selectedSession}
        targetSession={navigationTargetSession}
        dirty={hasDirtyTitleEdit}
        open={confirmSessionNavigation !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmSessionNavigation(null)
          }
        }}
        onConfirm={() => {
          if (!confirmSessionNavigation) {
            return
          }
          const { targetSessionID, historyMode } = confirmSessionNavigation
          setConfirmSessionNavigation(null)
          completeSessionSelection(targetSessionID, historyMode)
        }}
      />
      <CreateSessionDialog open={createOpen} onOpenChange={setCreateOpen} onCreate={handleCreate} />
    </main>
  )
}

function SessionActionConfirmDialog({
  request,
  session,
  pending,
  onOpenChange,
  onConfirm,
}: {
  request: PendingSessionAction | null
  session: Session | null
  pending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const action = request?.action ?? 'compact'
  const copy = sessionActionDialogCopy(action)

  return (
    <Dialog open={Boolean(request)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <p className="truncate text-sm text-muted-foreground" title={session?.title || undefined}>
            {session?.title || 'Selected session'}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={pending} onClick={onConfirm}>
              {pending ? copy.pendingLabel : copy.confirmLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ArchiveSessionConfirmDialog({
  session,
  pending,
  onOpenChange,
  onConfirm,
}: {
  session: Session | null
  pending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const isArchived = Boolean(session?.archived_at)

  return (
    <Dialog open={Boolean(session)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isArchived ? 'Restore session?' : 'Archive session?'}</DialogTitle>
          <DialogDescription>
            {isArchived
              ? 'Return this session to the active list.'
              : 'Hide this session from the active list. Its event history and files remain stored.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <p className="truncate text-sm text-muted-foreground" title={session?.title || undefined}>
            {session?.title || 'Selected session'}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" variant={isArchived ? 'default' : 'destructive'} disabled={pending} onClick={onConfirm}>
              {pending ? (isArchived ? 'Restoring' : 'Archiving') : isArchived ? 'Restore' : 'Archive'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SessionNavigationConfirmDialog({
  currentSession,
  targetSession,
  dirty,
  open,
  onOpenChange,
  onConfirm,
}: {
  currentSession: Session | null
  targetSession: Session | null
  dirty: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{dirty ? 'Discard title edit?' : 'Leave title edit?'}</DialogTitle>
          <DialogDescription>
            {dirty
              ? 'Switching sessions now will discard the title changes you have not saved.'
              : 'The session title editor is still open. Finish the edit here or leave this session.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1 text-sm text-muted-foreground">
            <p className="truncate" title={currentSession?.title || undefined}>
              Editing: {currentSession?.title || 'Untitled session'}
            </p>
            <p className="truncate" title={targetSession?.title || undefined}>
              Switch to: {targetSession?.title || 'Selected session'}
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Keep editing
            </Button>
            <Button type="button" variant="destructive" onClick={onConfirm}>
              Discard and switch
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function sessionActionDialogCopy(action: CodexSessionAction) {
  if (action === 'clear') {
    return {
      title: 'Clear context?',
      description:
        'Start a fresh Codex thread for this Gorchestra session. Existing Gorchestra activity stays visible in the transcript.',
      confirmLabel: 'Clear',
      pendingLabel: 'Clearing',
    }
  }

  return {
    title: 'Compact context?',
    description:
      'Ask Codex to summarize the current thread context so the session can continue with less token pressure.',
    confirmLabel: 'Compact',
    pendingLabel: 'Compacting',
  }
}

function WorkspaceFileOverlay({
  sessionID,
  file,
  resolvedTheme,
  onFileSaved,
  onClose,
}: {
  sessionID: string
  file: WorkspaceFileContent
  resolvedTheme: 'light' | 'dark'
  onFileSaved: (file: WorkspaceFileContent) => void
  onClose: () => void
}) {
  const markdown = file.encoding !== 'binary' && isMarkdownFile(file)
  const editable = file.encoding === 'utf-8' && !file.truncated
  const displayPath = file.path || file.name
  const [mode, setMode] = useState<FileOverlayMode>(markdown ? 'preview' : 'edit')
  const [draft, setDraft] = useState(file.content)
  const [saveState, setSaveState] = useState<FileSaveState>('clean')
  const [saveError, setSaveError] = useState('')
  const saveResetTimerRef = useRef<number | null>(null)
  const dirty = draft !== file.content

  const clearSaveResetTimer = useCallback(() => {
    if (saveResetTimerRef.current === null) {
      return
    }
    window.clearTimeout(saveResetTimerRef.current)
    saveResetTimerRef.current = null
  }, [])

  useEffect(() => {
    clearSaveResetTimer()
    setMode(markdown ? 'preview' : 'edit')
    setDraft(file.content)
    setSaveState('clean')
    setSaveError('')
  }, [clearSaveResetTimer, file.content, file.path, file.name, markdown])

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
    <section
      role="dialog"
      aria-modal="true"
      aria-label={`File viewer: ${file.name}`}
      className="command-file-overlay absolute inset-0 z-50 flex min-h-0 flex-col"
    >
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border/70 px-4">
        <div className="flex min-w-0 items-center gap-3">
          <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h2 className="min-w-0 truncate font-mono text-xs font-semibold" title={displayPath}>
            {displayPath}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
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
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Close file viewer"
            onClick={onClose}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className={cn('min-h-0 flex-1 p-4', editable && mode === 'edit' ? 'overflow-hidden' : 'overflow-auto')}>
        {file.encoding === 'binary' ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Binary preview unavailable
          </div>
        ) : markdown ? (
          mode === 'preview' ? (
            <MarkdownFilePreview content={draft} />
          ) : (
            <WorkspaceFileEditor file={file} value={draft} resolvedTheme={resolvedTheme} onChange={handleDraftChange} />
          )
        ) : editable ? (
          <WorkspaceFileEditor file={file} value={draft} resolvedTheme={resolvedTheme} onChange={handleDraftChange} />
        ) : (
          <pre className="min-h-full overflow-auto rounded-md bg-surface-muted/80 p-4 text-xs leading-relaxed text-foreground">
            <code>{file.content}</code>
          </pre>
        )}
      </div>

      {file.truncated || saveState !== 'clean' ? (
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border/70 px-4 py-2 text-xs text-muted-foreground">
          <span>{file.truncated ? 'Preview truncated' : saveStatusText(saveState)}</span>
          {saveError ? <span className="text-destructive">{saveError}</span> : null}
        </footer>
      ) : null}
    </section>
  )
}

function WorkspaceFileEditor({
  file,
  value,
  resolvedTheme,
  onChange,
}: {
  file: WorkspaceFileContent
  value: string
  resolvedTheme: 'light' | 'dark'
  onChange: (value: string | undefined) => void
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

function MarkdownFilePreview({ content }: { content: string }) {
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
          code: MarkdownPreviewCode,
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

function MarkdownPreviewCode({ children, className }: ComponentProps<'code'>) {
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

function PaneResizeHandle({
  label,
  value,
  min,
  max,
  onPointerDown,
  onKeyDown,
}: {
  label: string
  value: number
  min: number
  max: number
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}) {
  return (
    <button
      type="button"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      className="pane-resize-handle hidden shrink-0 lg:block"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  )
}

async function includeSelectedSession(
  sessions: Session[],
  selectedSessionID: string | null,
  includeArchived: boolean,
) {
  if (!selectedSessionID || sessions.some((session) => session.id === selectedSessionID)) {
    return sessions
  }

  try {
    const selectedSession = await getSession(selectedSessionID)
    if (selectedSession.archived_at && !includeArchived) {
      return sessions
    }
    return [selectedSession, ...sessions]
  } catch {
    return sessions
  }
}

function applySessionEvent(session: Session, event: AgentEvent, status: SessionStatus | null) {
  const currentLastSeq = latestSessionSeq(session)
  if (event.seq <= currentLastSeq) {
    return session
  }
  const nextLastSeq = Math.max(currentLastSeq, event.seq)
  const eventCount = Math.max(session.event_count ?? 0, event.seq)
  const toolCount = (session.tool_count ?? 0) + (isToolActivityEvent(event) ? 1 : 0)
  const pendingInput = pendingInputFromEvent(session.pending_input ?? false, event)
  if (!status) {
    return {
      ...session,
      event_count: eventCount,
      last_event_seq: nextLastSeq,
      tool_count: toolCount,
      pending_input: pendingInput,
    }
  }

  const updatedAt = payloadString(event.payload, 'updated_at') ?? event.created_at
  const completedAt =
    status === 'running' || status === 'idle'
      ? null
      : (payloadString(event.payload, 'completed_at') ?? event.created_at)

  return {
    ...session,
    status,
    event_count: eventCount,
    last_event_seq: nextLastSeq,
    tool_count: toolCount,
    pending_input: pendingInput,
    updated_at: updatedAt,
    completed_at: completedAt,
  }
}

function pendingInputFromEvent(current: boolean, event: AgentEvent) {
  if (event.type === 'agent.input.requested') {
    return true
  }
  if (event.type === 'agent.input.answered' || isTerminalEvent(event.type)) {
    return false
  }
  return current
}

function isToolActivityEvent(event: AgentEvent) {
  return event.type === 'tool.call.started' || event.type === 'file.change.started'
}

function payloadString(payload: unknown, key: string) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null
  }
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

function sortSessions(sessions: Session[]) {
  return [...sessions].sort((left, right) => {
    const byUpdated = new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
    return byUpdated !== 0 ? byUpdated : right.id.localeCompare(left.id)
  })
}

function paneWidthStyle(width: number): CSSProperties {
  return { width: `${Math.round(width)}px` }
}

function loadPaneWidths() {
  if (typeof window === 'undefined') {
    return defaultPaneWidths
  }
  try {
    const raw = window.localStorage.getItem(paneWidthsStorageKey)
    if (!raw) {
      return defaultPaneWidths
    }
    const parsed = JSON.parse(raw) as Partial<PaneWidths>
    return clampStoredPaneWidths({
      left: Number(parsed.left) || defaultPaneWidths.left,
      right: Number(parsed.right) || defaultPaneWidths.right,
    })
  } catch {
    return defaultPaneWidths
  }
}

function savePaneWidths(widths: PaneWidths) {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(paneWidthsStorageKey, JSON.stringify(widths))
  } catch {
    // Resizing remains functional when storage is unavailable.
  }
}

function clampStoredPaneWidths(widths: PaneWidths): PaneWidths {
  return {
    left: clamp(widths.left, paneLimits.leftMin, paneLimits.leftMax),
    right: clamp(widths.right, paneLimits.rightMin, paneLimits.rightMax),
  }
}

function clampPaneWidths(widths: PaneWidths, changedSide?: PaneSide): PaneWidths {
  let next = clampStoredPaneWidths(widths)
  if (typeof window === 'undefined') {
    return next
  }

  const maxCombinedWidth = Math.max(
    paneLimits.leftMin + paneLimits.rightMin,
    window.innerWidth - paneLimits.centerMin - 18,
  )
  let overflow = next.left + next.right - maxCombinedWidth
  if (overflow <= 0) {
    return next
  }

  if (changedSide === 'left') {
    const leftReduction = Math.min(overflow, next.left - paneLimits.leftMin)
    next = { ...next, left: next.left - leftReduction }
    overflow -= leftReduction
  } else {
    const rightReduction = Math.min(overflow, next.right - paneLimits.rightMin)
    next = { ...next, right: next.right - rightReduction }
    overflow -= rightReduction
  }

  if (overflow > 0) {
    if (changedSide === 'left') {
      next = {
        ...next,
        right: Math.max(paneLimits.rightMin, next.right - overflow),
      }
    } else {
      next = {
        ...next,
        left: Math.max(paneLimits.leftMin, next.left - overflow),
      }
    }
  }

  return next
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

function workspaceRelativeFilePath(path: string, workspacePath: string) {
  const filePath = path.trim().replaceAll('\\', '/').replace(/:\d+(?::\d+)?$/, '')
  if (!filePath) {
    throw new Error('File path is unavailable.')
  }
  if (!filePath.startsWith('/')) {
    return filePath.replace(/^\.\//, '')
  }

  const workspaceRoot = workspacePath.trim().replaceAll('\\', '/').replace(/\/+$/, '')
  if (workspaceRoot && filePath.startsWith(`${workspaceRoot}/`)) {
    return filePath.slice(workspaceRoot.length + 1)
  }
  throw new Error('File change is outside the session workspace.')
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed'
}

function healthLabel(state: HealthState) {
  switch (state) {
    case 'online':
      return ''
    case 'offline':
      return 'Backend offline.'
    default:
      return ''
  }
}

function loadSessionDebugPreference(sessionID: string | null) {
  if (!sessionID) {
    return false
  }
  try {
    return window.localStorage.getItem(debugStorageKey(sessionID)) === 'true'
  } catch {
    return false
  }
}

function saveSessionDebugPreference(sessionID: string | null, showDebugEvents: boolean) {
  if (!sessionID) {
    return
  }
  try {
    window.localStorage.setItem(debugStorageKey(sessionID), String(showDebugEvents))
  } catch {
    // Keep the UI functional when storage is unavailable.
  }
}

function loadSessionSeenSeqs(): Record<string, number> {
  if (typeof window === 'undefined') {
    return {}
  }
  try {
    const raw = window.localStorage.getItem(sessionSeenSeqStorageKey)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const seen: Record<string, number> = {}
    for (const [sessionID, value] of Object.entries(parsed)) {
      const seq = Number(value)
      if (sessionID && Number.isFinite(seq) && seq > 0) {
        seen[sessionID] = seq
      }
    }
    return seen
  } catch {
    return {}
  }
}

function saveSessionSeenSeqs(seenSeqs: Record<string, number>) {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(sessionSeenSeqStorageKey, JSON.stringify(seenSeqs))
  } catch {
    // Seen state is best-effort and browser-local.
  }
}

function debugStorageKey(sessionID: string) {
  return `${debugStorageKeyPrefix}${sessionID}`
}

function selectedSessionIDFromLocation() {
  if (typeof window === 'undefined') {
    return null
  }
  return sessionIDFromPathname(window.location.pathname)
}

function writeSelectedSessionRoute(sessionID: string | null, historyMode: Exclude<SessionRouteHistoryMode, 'none'>) {
  if (typeof window === 'undefined') {
    return
  }

  const path = sessionPath(sessionID)
  if (window.location.pathname === path) {
    return
  }

  if (historyMode === 'replace') {
    window.history.replaceState({}, '', path)
    return
  }
  window.history.pushState({}, '', path)
}

export default App
