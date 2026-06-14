import { Menu, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import type {
  AgentEvent,
  AgentType,
  MessageAttachment,
  Session,
  SessionStatus,
  SubmitAgentOptions,
  UserInputAnswers,
} from '@/lib/api'
import {
  APIError,
  answerUserInput,
  archiveSession,
  cancelSession,
  createSession,
  fetchHealth,
  getSession,
  listSessions,
  submitMessage,
  updateSessionTitle,
} from '@/lib/api'
import { isTerminalEvent, statusFromEvent } from '@/lib/events'
import { nextSessionIDAfterArchive } from '@/lib/sessions'
import { useSessionEvents } from '@/hooks/use-session-events'
import { useTheme } from '@/hooks/use-theme'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { CreateSessionDialog } from '@/components/create-session-dialog'
import { RunHealthRail } from '@/components/run-health-rail'
import { SessionDetail } from '@/components/session-detail'
import { SessionList } from '@/components/session-list'
import { StatusBadge } from '@/components/status-badge'
import { sessionIDFromPathname, sessionPath } from '@/lib/routes'

type HealthState = 'checking' | 'online' | 'offline'
type SessionRouteHistoryMode = 'push' | 'replace' | 'none'
const debugStorageKeyPrefix = 'gorchestra.session-debug.'

function App() {
  const [healthState, setHealthState] = useState<HealthState>('checking')
  const [sessions, setSessions] = useState<Session[]>([])
  const [selectedSessionID, setSelectedSessionID] = useState<string | null>(() => selectedSessionIDFromLocation())
  const [createOpen, setCreateOpen] = useState(false)
  const [mobileListOpen, setMobileListOpen] = useState(false)
  const [loadingSessions, setLoadingSessions] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showDebugEvents, setShowDebugEvents] = useState(false)
  const [archivingSessionID, setArchivingSessionID] = useState<string | null>(null)
  const selectedSessionIDRef = useRef<string | null>(selectedSessionID)

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionID) ?? null,
    [selectedSessionID, sessions],
  )
  const theme = useTheme()

  const applySession = useCallback((session: Session) => {
    setSessions((current) => {
      if (session.archived_at) {
        return current.filter((item) => item.id !== session.id)
      }
      return sortSessions([session, ...current.filter((item) => item.id !== session.id)])
    })
  }, [])

  const selectSession = useCallback((sessionID: string | null, historyMode: SessionRouteHistoryMode = 'push') => {
    selectedSessionIDRef.current = sessionID
    setSelectedSessionID(sessionID)
    if (historyMode !== 'none') {
      writeSelectedSessionRoute(sessionID, historyMode)
    }
  }, [])

  const refreshSession = useCallback(
    async (sessionID: string) => {
      const session = await getSession(sessionID)
      applySession(session)
      return session
    },
    [applySession],
  )

  useEffect(() => {
    selectedSessionIDRef.current = selectedSessionID
  }, [selectedSessionID])

  useEffect(() => {
    function handlePopState() {
      selectSession(selectedSessionIDFromLocation(), 'none')
      setMobileListOpen(false)
      setNotice('')
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [selectSession])

  useEffect(() => {
    setShowDebugEvents(loadSessionDebugPreference(selectedSessionID))
  }, [selectedSessionID])

  const handleSessionEvent = useCallback(
    (event: AgentEvent) => {
      const status = statusFromEvent(event)
      if (status) {
        setSessions((current) =>
          current.map((session) =>
            session.id === event.session_id ? applyStatusEvent(session, event, status) : session,
          ),
        )
      }
      if (isTerminalEvent(event.type)) {
        window.setTimeout(() => {
          void refreshSession(event.session_id)
        }, 250)
      }
    },
    [refreshSession],
  )

  const { events, streamState, error: streamError } = useSessionEvents(selectedSessionID, {
    onEvent: handleSessionEvent,
  })

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true)
    setError('')
    try {
      const nextSessions = await listSessions()
      const selectedID = selectedSessionIDRef.current
      const mergedSessions = await includeSelectedSession(nextSessions, selectedID)
      const nextSelectedID = selectedID && mergedSessions.some((session) => session.id === selectedID)
        ? selectedID
        : (nextSessions[0]?.id ?? mergedSessions[0]?.id ?? null)

      setSessions(sortSessions(mergedSessions))
      selectSession(nextSelectedID, 'replace')
    } catch (loadError) {
      setError(messageFromError(loadError))
    } finally {
      setLoadingSessions(false)
    }
  }, [selectSession])

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

  async function handleCreate(params: { agent_type: AgentType; title?: string }) {
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
  ) {
    if (!selectedSessionID) {
      throw new Error('Select a session first.')
    }
    const response = await submitMessage(selectedSessionID, content, agentOptions, attachments)
    setSessions((current) =>
      current.map((session) =>
        session.id === selectedSessionID
          ? { ...session, status: response.status, completed_at: response.status === 'running' ? null : session.completed_at }
          : session,
      ),
    )
    setNotice('')
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

  async function handleUpdateTitle(title: string) {
    if (!selectedSessionID) {
      return
    }
    const updated = await updateSessionTitle(selectedSessionID, title)
    applySession(updated)
  }

  async function handleArchiveSession() {
    if (!selectedSessionID) {
      return
    }

    const sessionID = selectedSessionID
    const nextSelectedID = nextSessionIDAfterArchive(sessions, sessionID, selectedSessionID)
    setArchivingSessionID(sessionID)
    setError('')
    try {
      await archiveSession(sessionID)
      setSessions((current) => current.filter((session) => session.id !== sessionID))
      selectSession(nextSelectedID, 'replace')
      setNotice('')
    } catch (archiveError) {
      setError(messageFromError(archiveError))
      if (archiveError instanceof APIError && archiveError.status === 409) {
        await refreshSession(sessionID)
      }
    } finally {
      setArchivingSessionID((current) => (current === sessionID ? null : current))
    }
  }

  function handleRefresh() {
    void loadSessions()
    if (selectedSessionID) void refreshSession(selectedSessionID)
  }

  const list = (
    <SessionList
      sessions={sessions}
      selectedSessionID={selectedSessionID}
      connectedSessionID={streamState === 'connected' && !streamError ? selectedSessionID : null}
      onSelect={(sessionID) => {
        selectSession(sessionID, 'push')
        setMobileListOpen(false)
        setNotice('')
      }}
      onCreate={() => setCreateOpen(true)}
      themePreference={theme.preference}
      resolvedTheme={theme.resolvedTheme}
      onThemeToggle={theme.nextPreference}
    />
  )

  return (
    <main className="app-shell">
      <div className="hidden min-h-0 w-[348px] lg:flex">{list}</div>

      <section className="command-workspace flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b bg-background/84 px-3 lg:hidden">
          <Sheet open={mobileListOpen} onOpenChange={setMobileListOpen}>
            <SheetTrigger asChild>
              <Button size="icon" variant="outline" aria-label="Open sessions">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Sessions</SheetTitle>
              </SheetHeader>
              <div className="min-h-0 flex-1">{list}</div>
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

        {error ? (
          <div role="alert" className="shrink-0 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {loadingSessions ? (
          <div className="shrink-0 border-b px-4 py-2 text-sm text-muted-foreground">Loading sessions...</div>
        ) : null}

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <SessionDetail
            session={selectedSession}
            events={events}
            streamState={streamState}
            streamError={streamError}
            notice={notice || healthLabel(healthState)}
            showDebugEvents={showDebugEvents}
            onShowDebugEventsChange={handleShowDebugEventsChange}
            onSubmitPrompt={handleSubmitPrompt}
            onAnswerUserInput={handleAnswerUserInput}
            onCancel={handleCancel}
            onUpdateTitle={handleUpdateTitle}
            onRefresh={handleRefresh}
          />
        </div>
      </section>

      <div className="hidden min-h-0 lg:flex">
        <RunHealthRail
          session={selectedSession}
          events={events}
          streamState={streamState}
          streamError={streamError}
          onArchive={handleArchiveSession}
          archivePending={selectedSession ? archivingSessionID === selectedSession.id : false}
        />
      </div>

      <CreateSessionDialog open={createOpen} onOpenChange={setCreateOpen} onCreate={handleCreate} />
    </main>
  )
}

async function includeSelectedSession(sessions: Session[], selectedSessionID: string | null) {
  if (!selectedSessionID || sessions.some((session) => session.id === selectedSessionID)) {
    return sessions
  }

  try {
    const selectedSession = await getSession(selectedSessionID)
    if (selectedSession.archived_at) {
      return sessions
    }
    return [selectedSession, ...sessions]
  } catch {
    return sessions
  }
}

function applyStatusEvent(session: Session, event: AgentEvent, status: SessionStatus) {
  const updatedAt = payloadString(event.payload, 'updated_at') ?? event.created_at
  const completedAt =
    status === 'running' || status === 'idle'
      ? null
      : (payloadString(event.payload, 'completed_at') ?? event.created_at)

  return {
    ...session,
    status,
    updated_at: updatedAt,
    completed_at: completedAt,
  }
}

function payloadString(payload: unknown, key: string) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null
  }
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

function sortSessions(sessions: Session[]) {
  return [...sessions].filter((session) => !session.archived_at).sort((left, right) => {
    const byUpdated = new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
    return byUpdated !== 0 ? byUpdated : right.id.localeCompare(left.id)
  })
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
