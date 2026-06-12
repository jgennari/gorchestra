import { Menu, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import type { AgentType, Session, SessionListFilter } from '@/lib/api'
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
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { CreateSessionDialog } from '@/components/create-session-dialog'
import { SessionDetail } from '@/components/session-detail'
import { SessionList } from '@/components/session-list'
import { StatusBadge } from '@/components/status-badge'

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
  const selectedSessionIDRef = useRef<string | null>(null)

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionID) ?? null,
    [selectedSessionID, sessions],
  )

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

  const { events, streamState, error: streamError } = useSessionEvents(selectedSessionID, {
    onEvent: (event) => {
      const status = statusFromEvent(event.type)
      if (status && selectedSessionID) {
        setSessions((current) =>
          current.map((session) =>
            session.id === selectedSessionID
              ? { ...session, status, updated_at: event.created_at, completed_at: status === 'running' ? null : event.created_at }
              : session,
          ),
        )
      }
      if (selectedSessionID && isTerminalEvent(event.type)) {
        window.setTimeout(() => {
          void refreshSession(selectedSessionID)
        }, 250)
      }
    },
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

  async function handleSubmitPrompt(content: string) {
    if (!selectedSessionID) {
      throw new Error('Select a session first.')
    }
    const response = await submitMessage(selectedSessionID, content)
    setSessions((current) =>
      current.map((session) =>
        session.id === selectedSessionID ? { ...session, status: response.status } : session,
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
      <div className="hidden min-h-0 w-[360px] lg:flex">{list}</div>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 items-center justify-between gap-3 border-b bg-background px-3 lg:hidden">
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
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{selectedSession?.title || 'Gorchestra'}</p>
            <p className="truncate text-xs text-muted-foreground">{selectedSession?.agent_type || 'No session'}</p>
          </div>
          {selectedSession ? <StatusBadge status={selectedSession.status} /> : null}
          <Button size="icon" onClick={() => setCreateOpen(true)} aria-label="Create session">
            <Plus />
          </Button>
        </header>

        {error ? (
          <div role="alert" className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {loadingSessions ? (
          <div className="border-b px-4 py-2 text-sm text-muted-foreground">Loading sessions...</div>
        ) : null}

        <div className="min-h-0 flex-1">
          <SessionDetail
            session={selectedSession}
            events={events}
            streamState={streamState}
            streamError={streamError}
            notice={notice || healthLabel(healthState)}
            onSubmitPrompt={handleSubmitPrompt}
            onCancel={handleCancel}
            onUpdateTitle={handleUpdateTitle}
            onRefresh={() => {
              void loadSessions()
              if (selectedSessionID) void refreshSession(selectedSessionID)
            }}
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
      return 'Backend online.'
    case 'offline':
      return 'Backend offline.'
    default:
      return 'Checking backend.'
  }
}

export default App
