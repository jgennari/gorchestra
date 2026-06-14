import { Menu, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import type { AgentEvent, AgentType, Session, SessionListFilter, SessionStatus, SubmitAgentOptions } from '@/lib/api'
import {
  APIError,
  cancelSession,
  createSession,
  fetchHealth,
  getSession,
  listSessions,
  submitMessage,
  updateSessionTitle,
} from '@/lib/api'
import { isTerminalEvent, statusFromEvent } from '@/lib/events'
import { useSessionEvents } from '@/hooks/use-session-events'
import { useTheme } from '@/hooks/use-theme'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { CreateSessionDialog } from '@/components/create-session-dialog'
import { RunHealthRail, type MessageView } from '@/components/run-health-rail'
import { SessionDetail } from '@/components/session-detail'
import { SessionList } from '@/components/session-list'
import { StatusBadge } from '@/components/status-badge'
import { ThemeToggle } from '@/components/theme-toggle'

type HealthState = 'checking' | 'online' | 'offline'

function App() {
  const [healthState, setHealthState] = useState<HealthState>('checking')
  const [sessions, setSessions] = useState<Session[]>([])
  const [selectedSessionID, setSelectedSessionID] = useState<string | null>(null)
  const [sessionFilter, setSessionFilter] = useState<SessionListFilter>('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [mobileListOpen, setMobileListOpen] = useState(false)
  const [loadingSessions, setLoadingSessions] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [messageView, setMessageView] = useState<MessageView>('chat')
  const selectedSessionIDRef = useRef<string | null>(null)

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionID) ?? null,
    [selectedSessionID, sessions],
  )
  const theme = useTheme()

  const applySession = useCallback((session: Session) => {
    setSessions((current) => sortSessions([session, ...current.filter((item) => item.id !== session.id)]))
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
      const status = sessionFilter === 'all' ? undefined : sessionFilter
      const nextSessions = await listSessions({ status })
      const selectedID = selectedSessionIDRef.current
      const mergedSessions = await includeSelectedSession(nextSessions, selectedID)

      setSessions(sortSessions(mergedSessions))
      setSelectedSessionID((current) => {
        if (current && mergedSessions.some((session) => session.id === current)) {
          return current
        }
        return nextSessions[0]?.id ?? mergedSessions[0]?.id ?? null
      })
    } catch (loadError) {
      setError(messageFromError(loadError))
    } finally {
      setLoadingSessions(false)
    }
  }, [sessionFilter])

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
    setSelectedSessionID(session.id)
    setNotice('')
    return session
  }

  async function handleSubmitPrompt(content: string, agentOptions?: SubmitAgentOptions) {
    if (!selectedSessionID) {
      throw new Error('Select a session first.')
    }
    const response = await submitMessage(selectedSessionID, content, agentOptions)
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

  async function handleUpdateTitle(title: string) {
    if (!selectedSessionID) {
      return
    }
    const updated = await updateSessionTitle(selectedSessionID, title)
    applySession(updated)
  }

  function handleRefresh() {
    void loadSessions()
    if (selectedSessionID) void refreshSession(selectedSessionID)
  }

  const list = (
    <SessionList
      sessions={sessions}
      selectedSessionID={selectedSessionID}
      filter={sessionFilter}
      onFilterChange={setSessionFilter}
      onSelect={(sessionID) => {
        setSelectedSessionID(sessionID)
        setMobileListOpen(false)
        setNotice('')
      }}
      onCreate={() => setCreateOpen(true)}
    />
  )

  return (
    <main className="app-shell">
      <div className="hidden min-h-0 w-[348px] lg:flex">{list}</div>
      <div className="hidden min-h-0 lg:flex">
        <RunHealthRail
          session={selectedSession}
          events={events}
          streamState={streamState}
          streamError={streamError}
          notice={notice || healthLabel(healthState)}
          messageView={messageView}
          onMessageViewChange={setMessageView}
          onUpdateTitle={handleUpdateTitle}
        />
      </div>

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
          <ThemeToggle
            preference={theme.preference}
            resolvedTheme={theme.resolvedTheme}
            onToggle={theme.nextPreference}
          />
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
          <div className="absolute right-3 top-3 z-30 hidden lg:block">
            <ThemeToggle
              preference={theme.preference}
              resolvedTheme={theme.resolvedTheme}
              onToggle={theme.nextPreference}
            />
          </div>
          <SessionDetail
            session={selectedSession}
            events={events}
            streamState={streamState}
            streamError={streamError}
            notice={notice || healthLabel(healthState)}
            messageView={messageView}
            onMessageViewChange={setMessageView}
            onSubmitPrompt={handleSubmitPrompt}
            onCancel={handleCancel}
            onUpdateTitle={handleUpdateTitle}
            onRefresh={handleRefresh}
          />
        </div>
      </section>

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
  return [...sessions].sort((left, right) => {
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

export default App
