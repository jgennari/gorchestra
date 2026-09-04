import { Archive, BookOpen, CalendarClock, Eraser, Folder, Loader2, Menu, MessageSquare, Minimize2, MoreHorizontal, PanelRightOpen, Plus, Server, Settings, Terminal, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import './App.css'
import type {
  AgentEvent,
  AgentType,
  MessageAttachment,
  Session,
  SessionAgentOptions,
  SessionStatus,
  SkillReference,
  SpotlightSearchResult,
  SubmitAgentOptions,
  UserInputAnswers,
  WorkspaceFileContent,
} from '@/lib/api'
import {
  APIError,
  answerUserInput,
  resolvePermission,
  archiveSession,
  cancelSession,
  clearSession,
  clearAllSessionNotificationAttention,
  clearSessionNotificationAttention,
  compactSession,
  createSession,
  getSession,
  getSessionFileContent,
  listSessions,
  restoreSession,
  sessionActivityStreamURL,
  submitMessage,
  updateSessionAgentOptions,
  updateSessionTitle,
  updateSessionWorkspace,
} from '@/lib/api'
import {
  appendEvent,
  isTransientEvent,
  isTerminalEvent,
  knownEventTypes,
  lastSeq,
  payloadText,
  shouldRefreshWorkspaceFilesForEvent,
  statusFromEvent,
} from '@/lib/events'
import { nextSessionIDAfterArchive } from '@/lib/sessions'
import { useSessionEvents } from '@/hooks/use-session-events'
import { useAppBadge } from '@/hooks/use-app-badge'
import { useFavicon } from '@/hooks/use-favicon'
import { usePushNotifications } from '@/hooks/use-push-notifications'
import { useReleaseUpdate } from '@/hooks/use-release-update'
import { useRailContentPreference } from '@/hooks/use-rail-content'
import { useTheme } from '@/hooks/use-theme'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { AppMenu } from '@/components/app-menu'
import { CreateSessionDialog } from '@/components/create-session-dialog'
import { DashboardOverview } from '@/components/dashboard-overview'
import { HostConsole } from '@/components/host-console'
import { HostPreview } from '@/components/host-preview'
import { NotificationsPopover } from '@/components/notifications-popover'
import { RunHealthRail } from '@/components/run-health-rail'
import { ChatSessionHeader, SessionDetail } from '@/components/session-detail'
import { SessionList } from '@/components/session-list'
import { SessionSchedules } from '@/components/session-schedules'
import { SessionSettings } from '@/components/session-settings'
import { RepositorySkills } from '@/components/repository-skills'
import { SpotlightSearch } from '@/components/spotlight-search'
import { WorkspaceFilesView } from '@/components/workspace-files'
import { hasSessionAttention, latestSessionSeq, sessionAttention } from '@/lib/session-attention'
import {
  clearNotificationAttention,
  readNotificationAttentionSeqs,
  writeNotificationAttention,
} from '@/lib/notification-attention'
import type { TranscriptSequenceRange } from '@/lib/events'
import {
  sessionPath,
  sessionRouteFromPathname,
  sessionSlugPath,
  sessionTitleSlug,
  type SessionRoute,
  type SessionRouteView,
} from '@/lib/routes'
import {
  readCachedSessionSnapshot,
  readCachedSessionSnapshotBySlug,
  readCachedSession as readPersistentCachedSession,
  writeCachedSession as writePersistentCachedSession,
  writeCachedSessions as writePersistentCachedSessions,
} from '@/lib/session-cache'
import { cn } from '@/lib/utils'
import { useAnchoredPopover } from '@/hooks/use-anchored-popover'

type SessionRouteHistoryMode = 'push' | 'replace' | 'none'
type PaneSide = 'left' | 'right'
type PaneWidths = {
  left: number
  right: number
}
type CodexSessionAction = 'clear' | 'compact'
type AppView = SessionRouteView
type PendingSessionAction = {
  action: CodexSessionAction
  sessionID: string
}
type ViewportDebugSnapshot = {
  inner: string
  outer: string
  documentElement: string
  visualViewport: string
  visualOffset: string
  scroll: string
  safeTop: string
  appRect: string
  screen: string
  dpr: string
}
type InitialSessionState = {
  sessions: Session[]
  selectedSessionID: string | null
  seededCachedSession: boolean
}

const debugStorageKeyPrefix = 'gorchestra.session-debug.'
const paneWidthsStorageKey = 'gorchestra.pane-widths.v1'
const sessionSeenSeqStorageKey = 'gorchestra.session-seen-seq.v1'
const dashboardActivityRefreshDelayMs = 750
const maximumActivityReconnectDelayMs = 15_000
const defaultPaneWidths: PaneWidths = { left: 348, right: 344 }
const paneLimits = {
  leftMin: 224,
  leftMax: 560,
  rightMin: 300,
  rightMax: 640,
  centerMin: 520,
}

function App() {
  const viewportDebug = useMemo(() => loadViewportDebugPreference(), [])
  const initialSessionState = useMemo(() => loadInitialSessionStateFromLocation(), [])
  const [sessions, setSessions] = useState<Session[]>(initialSessionState.sessions)
  const [selectedSessionID, setSelectedSessionID] = useState<string | null>(initialSessionState.selectedSessionID)
  const [createOpen, setCreateOpen] = useState(false)
  const [mobileListOpen, setMobileListOpen] = useState(false)
  const [mobileRailOpen, setMobileRailOpen] = useState(false)
  const [loadingSessions, setLoadingSessions] = useState(!initialSessionState.seededCachedSession)
  const [refreshingSessions, setRefreshingSessions] = useState(false)
  const [error, setError] = useState('')
  const [erroredSessionIDs, setErroredSessionIDs] = useState<ReadonlySet<string>>(() => new Set())
  const [showDebugEvents, setShowDebugEvents] = useState(false)
  const [archivingSessionID, setArchivingSessionID] = useState<string | null>(null)
  const [confirmArchiveSessionID, setConfirmArchiveSessionID] = useState<string | null>(null)
  const [confirmSessionAction, setConfirmSessionAction] = useState<PendingSessionAction | null>(null)
  const [pendingSessionAction, setPendingSessionAction] = useState<PendingSessionAction | null>(null)
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(() => loadPaneWidths())
  const [openWorkspaceFile, setOpenWorkspaceFile] = useState<WorkspaceFileContent | null>(null)
  const [workspaceFileDirty, setWorkspaceFileDirty] = useState(false)
  const [fileRefreshKey, setFileRefreshKey] = useState(0)
  const [eventRefreshKey, setEventRefreshKey] = useState(0)
  const [dashboardRefreshKey, setDashboardRefreshKey] = useState(0)
  const [lastSeenSeqBySession, setLastSeenSeqBySession] = useState<Record<string, number>>(() => loadSessionSeenSeqs())
  const [notificationAttentionSeqBySession, setNotificationAttentionSeqBySession] = useState<Record<string, number>>({})
  const [notificationAttentionRestored, setNotificationAttentionRestored] = useState(false)
  const [dismissingNotifications, setDismissingNotifications] = useState(false)
  const [spotlightOpen, setSpotlightOpen] = useState(false)
  const [composerFocusRequest, setComposerFocusRequest] = useState(0)
  const [focusedEventSeq, setFocusedEventSeq] = useState(() => eventSequenceFromLocation())
  const [focusedEventRequest, setFocusedEventRequest] = useState(0)
  const [transcriptVisibleRange, setTranscriptVisibleRange] = useState<TranscriptSequenceRange | null>(null)
  const [focusedFileLine, setFocusedFileLine] = useState(() => fileLineFromLocation())
  const [appView, setAppView] = useState<AppView>(() => selectedSessionRouteFromLocation().view)
  const [userSkillsSelected, setUserSkillsSelected] = useState(() => isUserSkillsLocation())
  const [overviewSelected, setOverviewSelected] = useState(() => !isSessionLocation() && !isUserSkillsLocation())
  const selectedSessionIDRef = useRef<string | null>(selectedSessionID)
  const overviewSelectedRef = useRef(overviewSelected)
  const appViewRef = useRef<AppView>(appView)
  const openWorkspaceFileRef = useRef<WorkspaceFileContent | null>(openWorkspaceFile)
  const sessionsRef = useRef<Session[]>(initialSessionState.sessions)
  const sessionListLoadedRef = useRef(initialSessionState.seededCachedSession)
  const selectedEventsRef = useRef<AgentEvent[]>([])
  const paneWidthsRef = useRef(paneWidths)
  const dashboardRefreshTimerRef = useRef<number | null>(null)

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionID) ?? null,
    [selectedSessionID, sessions],
  )
  const serverNotificationAttentionSeqBySession = useMemo(
    () => notificationAttentionSeqsFromSessions(sessions),
    [sessions],
  )
  const effectiveNotificationAttentionSeqBySession = useMemo(
    () => mergeNotificationAttentionSeqs(serverNotificationAttentionSeqBySession, notificationAttentionSeqBySession),
    [notificationAttentionSeqBySession, serverNotificationAttentionSeqBySession],
  )
  const effectiveLastSeenSeqBySession = useMemo(
    () => applyNotificationAttentionSeqs(lastSeenSeqBySession, effectiveNotificationAttentionSeqBySession),
    [effectiveNotificationAttentionSeqBySession, lastSeenSeqBySession],
  )
  const hasFaviconAttention = useMemo(
    () => hasSessionAttention(sessions, effectiveLastSeenSeqBySession),
    [effectiveLastSeenSeqBySession, sessions],
  )
  const appBadgeCount = useMemo(
    () =>
      sessions.reduce(
        (count, session) => count + (sessionAttention(session, effectiveLastSeenSeqBySession) === null ? 0 : 1),
        0,
      ),
    [effectiveLastSeenSeqBySession, sessions],
  )
  const dismissibleNotifications = useMemo(
    () =>
      sessions.filter(
        (session) => sessionAttention(session, effectiveLastSeenSeqBySession) === 'unseen-idle',
      ),
    [effectiveLastSeenSeqBySession, sessions],
  )
  const theme = useTheme()
  const railContent = useRailContentPreference()
  const release = useReleaseUpdate()
  const pushNotifications = usePushNotifications()
  const playSessionStopSound = pushNotifications.playSessionStopSound
  const showSessionStopNotification = pushNotifications.showSessionStopNotification
  useFavicon(hasFaviconAttention)
  useAppBadge(appBadgeCount)

  useEffect(() => {
    let cancelled = false
    async function restoreNotificationAttention() {
      const next = await readNotificationAttentionSeqs()
      const routeAttention = notificationAttentionFromLocation()
      if (routeAttention) {
        next[routeAttention.sessionID] = Math.max(next[routeAttention.sessionID] ?? 0, routeAttention.seq)
        void writeNotificationAttention(routeAttention.sessionID, routeAttention.seq)
        clearNotificationAttentionSearchParam()
      }
      if (!cancelled) {
        setNotificationAttentionSeqBySession(next)
        setNotificationAttentionRestored(true)
      }
    }

    void restoreNotificationAttention()
    return () => {
      cancelled = true
    }
  }, [])

  const clearNotificationAttentionForSession = useCallback((sessionID: string | null) => {
    if (!sessionID) {
      return
    }
    setNotificationAttentionSeqBySession((current) => {
      if (!(sessionID in current)) {
        return current
      }
      const next = { ...current }
      delete next[sessionID]
      return next
    })
    void clearNotificationAttention(sessionID)
    setSessions((current) => {
      let changed = false
      const next = current.map((session) => {
        if (session.id !== sessionID || !session.notification_attention_seq) {
          return session
        }
        changed = true
        return { ...session, notification_attention_seq: undefined }
      })
      if (!changed) {
        return current
      }
      sessionsRef.current = next
      const clearedSession = next.find((session) => session.id === sessionID)
      if (clearedSession) {
        void writePersistentCachedSession(clearedSession)
      }
      return next
    })
    void clearSessionNotificationAttention(sessionID)
      .then((updatedSession) => {
        setSessions((current) => {
          if (!current.some((session) => session.id === updatedSession.id)) {
            return current
          }
          const next = sortSessions(
            current.map((session) => (session.id === updatedSession.id ? updatedSession : session)),
          )
          sessionsRef.current = next
          void writePersistentCachedSession(updatedSession)
          return next
        })
      })
      .catch(() => undefined)
  }, [])

  const applySession = useCallback((session: Session) => {
    void writePersistentCachedSession(session)
    setSessions((current) => {
      let next: Session[]
      if (session.archived_at && session.id !== selectedSessionIDRef.current) {
        next = current.filter((item) => item.id !== session.id)
      } else {
        next = sortSessions([session, ...current.filter((item) => item.id !== session.id)])
      }
      sessionsRef.current = next
      return next
    })
  }, [])

  const selectSession = useCallback((sessionID: string | null, historyMode: SessionRouteHistoryMode = 'push') => {
    const nextOverviewSelected = sessionID === null
    overviewSelectedRef.current = nextOverviewSelected
    setOverviewSelected(nextOverviewSelected)
    setUserSkillsSelected(false)
    selectedSessionIDRef.current = sessionID
    setSelectedSessionID(sessionID)
    if (historyMode !== 'none') {
      setFocusedEventSeq(0)
      setFocusedFileLine(0)
      writeSelectedSessionRoute(sessionID, historyMode, appViewRef.current, sessionsRef.current)
    }
  }, [])

  const selectOverview = useCallback(
    (historyMode: SessionRouteHistoryMode = 'push') => {
      appViewRef.current = 'session'
      setAppView('session')
      selectSession(null, historyMode)
      setMobileListOpen(false)
    },
    [selectSession],
  )

  const selectUserSkills = useCallback((historyMode: SessionRouteHistoryMode = 'push') => {
    appViewRef.current = 'session'
    setAppView('session')
    overviewSelectedRef.current = false
    setOverviewSelected(false)
    setUserSkillsSelected(true)
    selectedSessionIDRef.current = null
    setSelectedSessionID(null)
    if (historyMode !== 'none' && window.location.pathname !== '/skills') {
      window.history[historyMode === 'replace' ? 'replaceState' : 'pushState']({}, '', '/skills')
    }
    setMobileListOpen(false)
  }, [])

  const selectAppView = useCallback(
    (view: AppView, historyMode: Exclude<SessionRouteHistoryMode, 'none'> = 'push', filePath: string | null = null) => {
      if (view === 'session') {
        setComposerFocusRequest((current) => current + 1)
      }
      appViewRef.current = view
      setAppView(view)
      setFocusedEventSeq(0)
      setFocusedFileLine(0)
      writeSelectedSessionRoute(
        selectedSessionIDRef.current,
        historyMode,
        view,
        sessionsRef.current,
        view === 'files' ? (filePath ?? openWorkspaceFileRef.current?.path ?? null) : null,
      )
    },
    [],
  )

  const completeSessionSelection = useCallback(
    (sessionID: string | null, historyMode: SessionRouteHistoryMode = 'push') => {
      clearNotificationAttentionForSession(sessionID)
      selectSession(sessionID, historyMode)
      setMobileListOpen(false)
    },
    [clearNotificationAttentionForSession, selectSession],
  )

  const requestSessionSelection = useCallback(
    (sessionID: string | null, historyMode: SessionRouteHistoryMode = 'push') => {
      if (sessionID && appViewRef.current === 'session') {
        setComposerFocusRequest((current) => current + 1)
      }
      if (sessionID === selectedSessionIDRef.current) {
        clearNotificationAttentionForSession(sessionID)
        return
      }
      completeSessionSelection(sessionID, historyMode)
    },
    [clearNotificationAttentionForSession, completeSessionSelection],
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

  const handleComposerFocus = useCallback(() => {
    const sessionID = selectedSessionIDRef.current
    if (!sessionID) return

    const session = sessionsRef.current.find((item) => item.id === sessionID) ?? null
    const latestSeq = Math.max(lastSeq(selectedEventsRef.current), latestSessionSeq(session))
    markSessionSeen(sessionID, latestSeq)

    const heldAttentionSeq = Math.max(
      effectiveNotificationAttentionSeqBySession[sessionID] ?? 0,
      session?.notification_attention_seq ?? 0,
    )
    if (heldAttentionSeq > 0) clearNotificationAttentionForSession(sessionID)
  }, [clearNotificationAttentionForSession, effectiveNotificationAttentionSeqBySession, markSessionSeen])

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
    setTranscriptVisibleRange(null)
  }, [selectedSessionID])

  useEffect(() => {
    overviewSelectedRef.current = overviewSelected
  }, [overviewSelected])

  useEffect(() => {
    appViewRef.current = appView
  }, [appView])

  useEffect(() => {
    openWorkspaceFileRef.current = openWorkspaceFile
  }, [openWorkspaceFile])

  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  useEffect(() => {
    paneWidthsRef.current = paneWidths
    savePaneWidths(paneWidths)
  }, [paneWidths])

  useEffect(() => {
    function handlePopState() {
      const route = selectedSessionRouteFromLocation()
      setFocusedEventSeq(eventSequenceFromLocation())
      setFocusedEventRequest((current) => current + 1)
      setFocusedFileLine(fileLineFromLocation())
      if (isUserSkillsLocation()) {
        selectUserSkills('none')
        return
      }
      if (!isSessionLocation()) {
        selectOverview('none')
        return
      }
      appViewRef.current = route.view
      setAppView(route.view)
      requestSessionSelection(resolveSessionRouteSessionID(route, sessionsRef.current), 'none')
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [requestSessionSelection, selectOverview, selectUserSkills])

  useEffect(() => {
    function handleNavigationShortcut(event: globalThis.KeyboardEvent) {
      if (
        event.defaultPrevented ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return
      }

      const key = event.key.toLowerCase()
      if (key === 'k') {
        event.preventDefault()
        setSpotlightOpen(true)
        return
      }
      if (key === 'o') {
        event.preventDefault()
        selectOverview('push')
        return
      }
      if (key === 's') {
        event.preventDefault()
        selectUserSkills('push')
        return
      }

      if (!/^[1-5]$/.test(key)) {
        return
      }
      const session = sessionsRef.current[Number(key) - 1]
      if (!session) {
        return
      }
      event.preventDefault()
      requestSessionSelection(session.id, 'push')
    }
    window.addEventListener('keydown', handleNavigationShortcut)
    return () => window.removeEventListener('keydown', handleNavigationShortcut)
  }, [requestSessionSelection, selectOverview, selectUserSkills])

  useEffect(() => {
    setShowDebugEvents(loadSessionDebugPreference(selectedSessionID))
    setOpenWorkspaceFile(null)
  }, [selectedSessionID])

  useEffect(() => {
    if (appView !== 'files') {
      return
    }

    const route = selectedSessionRouteFromLocation()
    if (route.view !== 'files') {
      return
    }

    if (!route.filePath) {
      if (openWorkspaceFileRef.current) {
        setOpenWorkspaceFile(null)
      }
      return
    }

    if (!selectedSessionID || !selectedSession || openWorkspaceFileRef.current?.path === route.filePath) {
      return
    }

    let cancelled = false
    setError('')
    void getSessionFileContent(selectedSessionID, route.filePath)
      .then((content) => {
        if (!cancelled) {
          setOpenWorkspaceFile(content)
        }
      })
      .catch((openError) => {
        if (!cancelled) {
          setError(messageFromError(openError))
        }
      })

    return () => {
      cancelled = true
    }
  }, [appView, selectedSession, selectedSessionID])

  useEffect(() => {
    if (!selectedSessionID || selectedSession) {
      return
    }

    let cancelled = false
    const sessionID = selectedSessionID
    void readPersistentCachedSession(sessionID).then((cachedSession) => {
      if (
        cancelled ||
        !cachedSession ||
        selectedSessionIDRef.current !== sessionID ||
        sessionsRef.current.some((session) => session.id === sessionID) ||
        (cachedSession.archived_at && cachedSession.id !== selectedSessionIDRef.current)
      ) {
        return
      }
      applySession(cachedSession)
    })

    return () => {
      cancelled = true
    }
  }, [applySession, selectedSession, selectedSessionID])

  const applySessionActivityEvent = useCallback((event: AgentEvent) => {
    const status = statusFromEvent(event)
    if (status && status !== 'failed') {
      setErroredSessionIDs((current) => removeSetValue(current, event.session_id))
    }
    setSessions((current) => {
      let changed = false
      const next = sortSessions(
        current.map((session) => {
          if (session.id !== event.session_id) {
            return session
          }
          const updatedSession = applySessionEvent(session, event, status)
          if (updatedSession === session) return session
          changed = true
          void writePersistentCachedSession(updatedSession)
          return updatedSession
        }),
      )
      return changed ? next : current
    })
  }, [])

  const scheduleDashboardRefresh = useCallback((immediate = false) => {
    if (!overviewSelectedRef.current) return

    const refresh = () => {
      dashboardRefreshTimerRef.current = null
      setDashboardRefreshKey((value) => value + 1)
    }
    if (immediate) {
      if (dashboardRefreshTimerRef.current !== null) {
        window.clearTimeout(dashboardRefreshTimerRef.current)
      }
      refresh()
      return
    }
    if (dashboardRefreshTimerRef.current === null) {
      dashboardRefreshTimerRef.current = window.setTimeout(refresh, dashboardActivityRefreshDelayMs)
    }
  }, [])

  useEffect(() => () => {
    if (dashboardRefreshTimerRef.current !== null) {
      window.clearTimeout(dashboardRefreshTimerRef.current)
    }
  }, [])

  const handleSessionEvent = useCallback(
    (event: AgentEvent) => {
      applySessionActivityEvent(event)
      selectedEventsRef.current = appendEvent(selectedEventsRef.current, event)
      playSessionStopSound(event)
      showSessionStopNotification(
        event,
        notificationDetailsForEvent(
          event,
          event.session_id === selectedSessionIDRef.current ? selectedEventsRef.current : [],
          sessionsRef.current,
        ),
      )
      if (shouldRefreshWorkspaceFilesForEvent(event) && event.session_id === selectedSessionIDRef.current) {
        setFileRefreshKey((value) => value + 1)
      }
      if (isTerminalEvent(event.type)) {
        window.setTimeout(() => {
          void refreshSession(event.session_id)
        }, 250)
      }
    },
    [applySessionActivityEvent, playSessionStopSound, refreshSession, showSessionStopNotification],
  )

  const handleActivityEvent = useCallback(
    (event: AgentEvent) => {
      applySessionActivityEvent(event)
      playSessionStopSound(event)
      showSessionStopNotification(
        event,
        notificationDetailsForEvent(
          event,
          event.session_id === selectedSessionIDRef.current ? selectedEventsRef.current : [],
          sessionsRef.current,
        ),
      )
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
      scheduleDashboardRefresh(isTerminalEvent(event.type))
    },
    [
      applySessionActivityEvent,
      markSessionUnseenAfter,
      playSessionStopSound,
      refreshSession,
      scheduleDashboardRefresh,
      showSessionStopNotification,
    ],
  )

  const {
    events,
    liveEvents,
    streamState,
    error: streamError,
    hasOlderEvents,
    hasNewerEvents,
    loadingOlderEvents,
    loadingNewerEvents,
    loadOlderEvents,
    loadNewerEvents,
    jumpToLatest,
    setFollowingTail,
  } = useSessionEvents(selectedSessionID, {
    onEvent: handleSessionEvent,
    refreshKey: eventRefreshKey,
    includeDebugEvents: showDebugEvents,
    targetSeq: focusedEventSeq,
  })

  const handleJumpToLatest = useCallback(() => {
    if (focusedEventSeq <= 0) return jumpToLatest()
    setFocusedEventSeq(0)
    const sessionID = selectedSessionIDRef.current
    if (appViewRef.current === 'session') {
      writeSelectedSessionRoute(sessionID, 'replace', 'session', sessionsRef.current)
    }
    return Promise.resolve()
  }, [focusedEventSeq, jumpToLatest])

  useEffect(() => {
    if (error) {
      setErroredSessionIDs((current) => addSetValue(current, selectedSessionIDRef.current))
    }
  }, [error])

  useEffect(() => {
    if (streamError) {
      setErroredSessionIDs((current) => addSetValue(current, selectedSessionIDRef.current))
    }
  }, [streamError])

  useEffect(() => {
    selectedEventsRef.current = liveEvents
  }, [liveEvents])

  useEffect(() => {
    if (!selectedSessionID || !notificationAttentionRestored) {
      return
    }
    const latestSeq = Math.max(lastSeq(liveEvents), latestSessionSeq(selectedSession))
    const heldAttentionSeq = effectiveNotificationAttentionSeqBySession[selectedSessionID] ?? 0
    if (heldAttentionSeq > 0 && latestSeq <= heldAttentionSeq) {
      return
    }
    markSessionSeen(selectedSessionID, latestSeq)
  }, [
    effectiveNotificationAttentionSeqBySession,
    liveEvents,
    markSessionSeen,
    notificationAttentionRestored,
    selectedSession,
    selectedSessionID,
  ])

  const loadSessions = useCallback(
    async (options: { showLoading?: boolean } = {}) => {
      const showLoading = options.showLoading ?? sessionsRef.current.length === 0
      if (showLoading) {
        setLoadingSessions(true)
        setError('')
      } else {
        setRefreshingSessions(true)
      }
      try {
        const nextSessions = await listSessions()
        const selectedID = selectedSessionIDRef.current
        const mergedSessions = await includeSelectedSession(nextSessions, selectedID)
        void writePersistentCachedSessions(mergedSessions)
        const route = selectedSessionRouteFromLocation()
        const routeSelectedID = resolveSessionRouteSessionID(route, mergedSessions)
        const preserveSlugRoute = Boolean(route.sessionSlug && routeSelectedID)
        const nextSelectedID =
          overviewSelectedRef.current && !isSessionLocation()
            ? null
            : routeSelectedID && mergedSessions.some((session) => session.id === routeSelectedID)
              ? routeSelectedID
              : !route.sessionSlug && selectedID && mergedSessions.some((session) => session.id === selectedID)
                ? selectedID
                : (nextSessions[0]?.id ?? mergedSessions[0]?.id ?? null)

        const sortedSessions = sortSessions(preferFresherSessionSnapshots(mergedSessions, sessionsRef.current))
        sessionsRef.current = sortedSessions
        setSessions(sortedSessions)
        if (isUserSkillsLocation()) {
          selectedSessionIDRef.current = null
          setSelectedSessionID(null)
          overviewSelectedRef.current = false
          setOverviewSelected(false)
          setUserSkillsSelected(true)
        } else {
          selectSession(nextSelectedID, preserveSlugRoute ? 'none' : 'replace')
        }
      } catch (loadError) {
        if (showLoading) {
          setError(messageFromError(loadError))
        }
      } finally {
        sessionListLoadedRef.current = true
        if (showLoading) {
          setLoadingSessions(false)
        } else {
          setRefreshingSessions(false)
        }
      }
    },
    [selectSession],
  )

  const handleDismissAllNotifications = useCallback(async () => {
    if (dismissingNotifications) return

    setDismissingNotifications(true)
    const currentSessions = sessionsRef.current
    const notificationSessionIDs = Object.keys(effectiveNotificationAttentionSeqBySession)
    const nextSeenSeqs = { ...lastSeenSeqBySession }
    for (const session of currentSessions) {
      const latestSeq = latestSessionSeq(session)
      if (latestSeq > 0) nextSeenSeqs[session.id] = latestSeq
    }
    saveSessionSeenSeqs(nextSeenSeqs)
    setLastSeenSeqBySession(nextSeenSeqs)
    setNotificationAttentionSeqBySession({})

    const clearedSessions = currentSessions.map((session) =>
      session.notification_attention_seq
        ? { ...session, notification_attention_seq: undefined }
        : session,
    )
    sessionsRef.current = clearedSessions
    setSessions(clearedSessions)
    void writePersistentCachedSessions(clearedSessions)

    try {
      await Promise.all([
        clearAllSessionNotificationAttention(),
        ...notificationSessionIDs.map((sessionID) => clearNotificationAttention(sessionID)),
      ])
    } catch (dismissError) {
      setError(messageFromError(dismissError))
      void loadSessions({ showLoading: false })
    } finally {
      setDismissingNotifications(false)
    }
  }, [
    dismissingNotifications,
    effectiveNotificationAttentionSeqBySession,
    lastSeenSeqBySession,
    loadSessions,
  ])

  useEffect(() => {
    let closed = false
    let source: EventSource | null = null
    let reconnectTimer: number | undefined
    let reconnectAttempt = 0
    let reconcileAfterOpen = false

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
      source = new EventSource(sessionActivityStreamURL(selectedSessionID))
      source.onopen = () => {
        if (closed) return
        reconnectAttempt = 0
        if (reconcileAfterOpen) {
          reconcileAfterOpen = false
          void loadSessions({ showLoading: false })
        }
      }
      source.onerror = () => {
        if (closed || reconnectTimer !== undefined) return
        reconcileAfterOpen = true
        closeSource()
        const delay = Math.min(1000 * 2 ** reconnectAttempt, maximumActivityReconnectDelayMs)
        reconnectAttempt += 1
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = undefined
          connect()
        }, delay)
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
  }, [handleActivityEvent, loadSessions, selectedSessionID])

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  useEffect(() => {
    if (!selectedSessionID || selectedSession || loadingSessions || !sessionListLoadedRef.current) {
      return
    }
    void refreshSession(selectedSessionID).catch((refreshError) => {
      setError(messageFromError(refreshError))
    })
  }, [loadingSessions, refreshSession, selectedSession, selectedSessionID])

  async function handleCreate(params: {
    agent_type: AgentType
    title?: string
    workspace_path?: string
    agent_options?: SessionAgentOptions
  }) {
    const session = await createSession(params)
    applySession(session)
    if (appViewRef.current === 'session') {
      setComposerFocusRequest((current) => current + 1)
    }
    selectSession(session.id, 'push')
    return session
  }

  async function handleSubmitPrompt(
    content: string,
    agentOptions?: SubmitAgentOptions,
    attachments: MessageAttachment[] = [],
    queue = false,
    skills: SkillReference[] = [],
    clientSubmissionID = '',
  ) {
    if (!selectedSessionID) {
      throw new Error('Select a session first.')
    }
    const response = await submitMessage(
      selectedSessionID,
      content,
      agentOptions,
      attachments,
      queue,
      skills,
      clientSubmissionID,
    )
    setSessions((current) =>
      current.map((session) => {
        if (session.id !== selectedSessionID) {
          return session
        }
        const updatedSession = {
          ...session,
          status: response.status,
          completed_at: response.status === 'running' ? null : session.completed_at,
        }
        void writePersistentCachedSession(updatedSession)
        return updatedSession
      }),
    )
    return response
  }

  async function handleCancel() {
    if (!selectedSessionID) {
      return
    }
    try {
      await cancelSession(selectedSessionID)
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
  }

  async function handleResolvePermission(requestID: string, optionID: string) {
    if (!selectedSessionID) throw new Error('Select a session first.')
    const sessionID = selectedSessionID
    try {
      await resolvePermission(sessionID, requestID, optionID)
    } finally {
      setEventRefreshKey((value) => value + 1)
      void refreshSession(sessionID)
    }
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

  async function handleUpdateWorkspace(workspacePath: string) {
    if (!selectedSessionID) {
      return
    }
    const updated = await updateSessionWorkspace(selectedSessionID, workspacePath)
    applySession(updated)
    setOpenWorkspaceFile(null)
    setWorkspaceFileDirty(false)
    setFileRefreshKey((value) => value + 1)
    if (appViewRef.current === 'files') {
      writeSelectedSessionRoute(selectedSessionID, 'replace', 'files', sessionsRef.current)
    }
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
    const nextSelectedID = nextSessionIDAfterArchive(sessions, sessionID, selectedSessionID)
    setArchivingSessionID(sessionID)
    setError('')
    try {
      const updatedSession = restoring ? await restoreSession(sessionID) : await archiveSession(sessionID)
      applySession(updatedSession)
      selectSession(restoring ? sessionID : nextSelectedID, 'replace')
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
        current.map((session) => {
          if (session.id !== sessionID) {
            return session
          }
          const updatedSession = {
            ...session,
            status: response.status,
            provider_session_id: action === 'clear' ? undefined : session.provider_session_id,
            completed_at: response.status === 'running' ? null : session.completed_at,
          }
          void writePersistentCachedSession(updatedSession)
          return updatedSession
        }),
      )
      if (action === 'clear') {
        await refreshSession(sessionID)
      }
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
        selectAppView('files', 'push', content.path)
      } catch (openError) {
        setError(messageFromError(openError))
      }
    },
    [selectAppView, selectedSession, selectedSessionID],
  )

  const handleOpenWorkspaceFile = useCallback(
    (file: WorkspaceFileContent) => {
      setMobileRailOpen(false)
      setOpenWorkspaceFile(file)
      setWorkspaceFileDirty(false)
      selectAppView('files', 'push', file.path)
    },
    [selectAppView],
  )

  const handleCloseWorkspaceFile = useCallback(() => {
    setOpenWorkspaceFile(null)
    setWorkspaceFileDirty(false)
    writeSelectedSessionRoute(selectedSessionIDRef.current, 'push', 'files', sessionsRef.current)
  }, [])

  async function handleSpotlightResult(result: SpotlightSearchResult) {
    setError('')
    try {
      const session =
        sessionsRef.current.find((item) => item.id === result.session_id) ?? (await getSession(result.session_id))
      selectedSessionIDRef.current = session.id
      applySession(session)
      selectSession(session.id, 'none')
      setMobileListOpen(false)
      setOverviewSelected(false)
      setUserSkillsSelected(false)
      setWorkspaceFileDirty(false)

      if ((result.kind === 'file' || result.kind === 'agent_instruction') && result.path) {
        const file = await getSessionFileContent(session.id, result.path)
        appViewRef.current = 'files'
        setAppView('files')
        setOpenWorkspaceFile(file)
        setFocusedEventSeq(0)
        setFocusedFileLine(result.line_number ?? 0)
        writeSpotlightResultRoute(session, 'files', result.path, {
          line: result.line_number,
        })
        return
      }

      appViewRef.current = 'session'
      setAppView('session')
      setComposerFocusRequest((current) => current + 1)
      setOpenWorkspaceFile(null)
      setFocusedFileLine(0)
      setFocusedEventSeq(result.event_seq ?? 0)
      setFocusedEventRequest((current) => current + 1)
      writeSpotlightResultRoute(session, 'session', null, {
        eventSeq: result.event_seq,
      })
    } catch (searchResultError) {
      setError(messageFromError(searchResultError))
    }
  }

  const handleSelectConversationSeq = useCallback((seq: number) => {
    const session = sessionsRef.current.find((item) => item.id === selectedSessionIDRef.current)
    if (!session || !Number.isSafeInteger(seq) || seq <= 0) return
    appViewRef.current = 'session'
    setAppView('session')
    setFocusedFileLine(0)
    setFocusedEventSeq(seq)
    setFocusedEventRequest((current) => current + 1)
    writeSpotlightResultRoute(session, 'session', null, { eventSeq: seq })
  }, [])

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

  const renderAppMenu = () => (
    <AppMenu
      themePreference={theme.preference}
      onThemeChange={theme.setPreference}
      release={release}
    />
  )

  const renderNotificationsPopover = () => (
    <NotificationsPopover
      notifications={dismissibleNotifications}
      supported={pushNotifications.supported}
      status={pushNotifications.status}
      error={pushNotifications.error}
      soundEnabled={pushNotifications.soundEnabled}
      dismissing={dismissingNotifications}
      onSelectSession={(sessionID) => requestSessionSelection(sessionID, 'push')}
      onDismissAll={handleDismissAllNotifications}
      onEnable={() => void pushNotifications.enable()}
      onDisable={() => void pushNotifications.disable()}
      onSoundEnabledChange={pushNotifications.setSoundEnabled}
    />
  )

  const chatErrorMessage = error || streamError
  const visibleErrorSessionIDs = new Set(erroredSessionIDs)
  if (selectedSession && chatErrorMessage) {
    visibleErrorSessionIDs.add(selectedSession.id)
  }
  const sessionListProps = {
    sessions,
    selectedSessionID,
    errorSessionIDs: visibleErrorSessionIDs,
    lastSeenSeqBySession: effectiveLastSeenSeqBySession,
    loading: loadingSessions || refreshingSessions,
    onSelect: (sessionID: string) => requestSessionSelection(sessionID, 'push'),
    overviewSelected,
    onOverview: () => selectOverview('push'),
    userSkillsSelected,
    onUserSkills: () => selectUserSkills('push'),
    onSearch: () => {
      setMobileListOpen(false)
      setSpotlightOpen(true)
    },
    onCreate: () => setCreateOpen(true),
    notificationAction: renderNotificationsPopover(),
    appMenuAction: renderAppMenu(),
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
  const confirmArchivePending = confirmArchiveSessionID !== null && archivingSessionID === confirmArchiveSessionID
  const viewToggle = (
    <SessionViewNavigation
      session={selectedSession}
      view={appView}
      onSelect={(view) => selectAppView(view)}
      onOpenWorkspaceDetails={() => setMobileRailOpen(true)}
      onClear={() => requestSessionAction('clear')}
      onCompact={() => requestSessionAction('compact')}
      onToggleArchive={requestArchiveSession}
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
  )
  const openSessionsButton = (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label="Open sessions"
      onClick={() => setMobileListOpen(true)}
      className="h-9 w-9 shrink-0 text-muted-foreground hover:bg-background/50 hover:text-foreground lg:hidden"
    >
      <Menu />
    </Button>
  )
  const floatingRepositorySkillsHeader = (
    <>
      <div
        data-testid="mobile-floating-skills-header"
        className="mobile-floating-header-shell pointer-events-none absolute inset-x-0 z-20 p-3 lg:hidden"
      >
        <FilesWorkspaceHeader
          session={selectedSession}
          resolvingSessionID={selectedSession ? null : selectedSessionID}
          fallbackTitle="Skills"
          errorMessage={error || streamError}
          leadingAction={openSessionsButton}
          headerActions={viewToggle}
          onUpdateTitle={handleUpdateTitle}
          onUpdateWorkspace={handleUpdateWorkspace}
          hasUnsavedWorkspaceFile={workspaceFileDirty}
          onUpdateAgentOptions={handleUpdateAgentOptions}
          showDebugEvents={showDebugEvents}
          onShowDebugEventsChange={handleShowDebugEventsChange}
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
          onOpenWorkspaceDetails={() => setMobileRailOpen(true)}
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
      <div
        data-testid="floating-skills-header"
        className="pointer-events-none absolute inset-x-0 top-0 z-20 hidden p-3 lg:block"
      >
        <FilesWorkspaceHeader
          session={selectedSession}
          resolvingSessionID={selectedSession ? null : selectedSessionID}
          fallbackTitle="Skills"
          errorMessage={error || streamError}
          headerActions={viewToggle}
          onUpdateTitle={handleUpdateTitle}
          onUpdateWorkspace={handleUpdateWorkspace}
          hasUnsavedWorkspaceFile={workspaceFileDirty}
          onUpdateAgentOptions={handleUpdateAgentOptions}
          showDebugEvents={showDebugEvents}
          onShowDebugEventsChange={handleShowDebugEventsChange}
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
          onOpenWorkspaceDetails={() => setMobileRailOpen(true)}
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
    </>
  )
  const currentSessionRoute = selectedSessionRouteFromLocation()
  const resolvingInitialSessionSelection = loadingSessions && !selectedSessionID
  const unresolvedRouteSessionKey = resolvingInitialSessionSelection
    ? (currentSessionRoute.sessionSlug ?? currentSessionRoute.sessionID ?? 'initial-session-selection')
    : null
  const resolvingSelectedSessionID = selectedSession ? null : (selectedSessionID ?? unresolvedRouteSessionKey)
  const resolvingChatSessionID = selectedSession ? null : (selectedSessionID ?? unresolvedRouteSessionKey)
  const isOverview = overviewSelected && selectedSessionID === null
  const isUserSkills = userSkillsSelected && selectedSessionID === null
  const isGlobalView = isOverview || isUserSkills

  return (
    <main className="app-shell">
      <div className="hidden min-h-0 shrink-0 lg:flex" style={paneWidthStyle(paneWidths.left)}>
        {list}
      </div>

      {!isGlobalView ? (
        <PaneResizeHandle
          label="Resize sessions pane"
          value={paneWidths.left}
          min={paneLimits.leftMin}
          max={paneLimits.leftMax}
          onPointerDown={(event) => beginPaneResize('left', event)}
          onKeyDown={(event) => handlePaneResizeKey('left', event)}
        />
      ) : null}

      <section className="command-workspace flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {isOverview ? (
            <DashboardOverview
              refreshKey={dashboardRefreshKey}
              onOpenSession={(sessionID) => requestSessionSelection(sessionID, 'push')}
              onOpenSessions={() => setMobileListOpen(true)}
              onCreate={() => setCreateOpen(true)}
            />
          ) : isUserSkills ? (
            <RepositorySkills userScope onOpenSessions={() => setMobileListOpen(true)} />
          ) : appView === 'settings' ? (
            <>
              <div
                data-testid="mobile-floating-settings-header"
                className="mobile-floating-header-shell pointer-events-none absolute inset-x-0 z-20 p-3 lg:hidden"
              >
                <FilesWorkspaceHeader
                  session={selectedSession}
                  resolvingSessionID={resolvingSelectedSessionID}
                  fallbackTitle="Settings"
                  errorMessage={error || streamError}
                  leadingAction={openSessionsButton}
                  headerActions={viewToggle}
                  onUpdateTitle={handleUpdateTitle}
                  onUpdateWorkspace={handleUpdateWorkspace}
                  hasUnsavedWorkspaceFile={workspaceFileDirty}
                  onUpdateAgentOptions={handleUpdateAgentOptions}
                  showDebugEvents={showDebugEvents}
                  onShowDebugEventsChange={handleShowDebugEventsChange}
                />
              </div>
              <div
                data-testid="floating-settings-header"
                className="pointer-events-none absolute inset-x-0 top-0 z-20 hidden p-3 lg:block"
              >
                <FilesWorkspaceHeader
                  session={selectedSession}
                  resolvingSessionID={resolvingSelectedSessionID}
                  fallbackTitle="Settings"
                  errorMessage={error || streamError}
                  headerActions={viewToggle}
                  onUpdateTitle={handleUpdateTitle}
                  onUpdateWorkspace={handleUpdateWorkspace}
                  hasUnsavedWorkspaceFile={workspaceFileDirty}
                  onUpdateAgentOptions={handleUpdateAgentOptions}
                  showDebugEvents={showDebugEvents}
                  onShowDebugEventsChange={handleShowDebugEventsChange}
                />
              </div>
              <SessionSettings
                session={selectedSession}
                resolvingSessionID={resolvingSelectedSessionID}
                showDebugEvents={showDebugEvents}
                onUpdateTitle={handleUpdateTitle}
                onUpdateWorkspace={handleUpdateWorkspace}
                hasUnsavedWorkspaceFile={workspaceFileDirty}
                onUpdateAgentOptions={handleUpdateAgentOptions}
                onShowDebugEventsChange={handleShowDebugEventsChange}
              />
            </>
          ) : appView === 'schedules' ? (
            <>
              <div
                data-testid="mobile-floating-schedules-header"
                className="mobile-floating-header-shell pointer-events-none absolute inset-x-0 z-20 p-3 lg:hidden"
              >
                <FilesWorkspaceHeader
                  session={selectedSession}
                  resolvingSessionID={resolvingSelectedSessionID}
                  fallbackTitle="Schedules"
                  errorMessage={error || streamError}
                  leadingAction={openSessionsButton}
                  headerActions={viewToggle}
                  onUpdateTitle={handleUpdateTitle}
                  onUpdateWorkspace={handleUpdateWorkspace}
                  hasUnsavedWorkspaceFile={workspaceFileDirty}
                  onUpdateAgentOptions={handleUpdateAgentOptions}
                  showDebugEvents={showDebugEvents}
                  onShowDebugEventsChange={handleShowDebugEventsChange}
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
                  onOpenWorkspaceDetails={() => setMobileRailOpen(true)}
                  clearPending={
                    selectedSession
                      ? pendingSessionAction?.sessionID === selectedSession.id &&
                        pendingSessionAction.action === 'clear'
                      : false
                  }
                  compactPending={
                    selectedSession
                      ? pendingSessionAction?.sessionID === selectedSession.id &&
                        pendingSessionAction.action === 'compact'
                      : false
                  }
                  archivePending={selectedSession ? archivingSessionID === selectedSession.id : false}
                />
              </div>
              <div
                data-testid="floating-schedules-header"
                className="pointer-events-none absolute inset-x-0 top-0 z-20 hidden p-3 lg:block"
              >
                <FilesWorkspaceHeader
                  session={selectedSession}
                  resolvingSessionID={resolvingSelectedSessionID}
                  fallbackTitle="Schedules"
                  errorMessage={error || streamError}
                  headerActions={viewToggle}
                  onUpdateTitle={handleUpdateTitle}
                  onUpdateWorkspace={handleUpdateWorkspace}
                  hasUnsavedWorkspaceFile={workspaceFileDirty}
                  onUpdateAgentOptions={handleUpdateAgentOptions}
                  showDebugEvents={showDebugEvents}
                  onShowDebugEventsChange={handleShowDebugEventsChange}
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
                  onOpenWorkspaceDetails={() => setMobileRailOpen(true)}
                  clearPending={
                    selectedSession
                      ? pendingSessionAction?.sessionID === selectedSession.id &&
                        pendingSessionAction.action === 'clear'
                      : false
                  }
                  compactPending={
                    selectedSession
                      ? pendingSessionAction?.sessionID === selectedSession.id &&
                        pendingSessionAction.action === 'compact'
                      : false
                  }
                  archivePending={selectedSession ? archivingSessionID === selectedSession.id : false}
                />
              </div>
              <SessionSchedules
                session={selectedSession}
                resolvingSessionID={resolvingSelectedSessionID}
                refreshKey={events.filter((event) => event.type.startsWith('schedule.')).length}
              />
            </>
          ) : appView === 'skills' ? (
            <>
              {floatingRepositorySkillsHeader}
              <RepositorySkills
                session={selectedSession}
                resolvingSessionID={resolvingSelectedSessionID}
                onOpenFile={(path) => void handleOpenWorkspacePath(path)}
              />
            </>
          ) : appView === 'console' ? (
            <HostConsole
              session={selectedSession}
              resolvingSessionID={resolvingSelectedSessionID}
              resolvedTheme={theme.resolvedTheme}
              headerActions={viewToggle}
              mobileLeadingAction={openSessionsButton}
            />
          ) : appView === 'host' ? (
            <>
              <div
                data-testid="mobile-floating-host-header"
                className="mobile-floating-header-shell pointer-events-none absolute inset-x-0 z-20 p-3 lg:hidden"
              >
                <FilesWorkspaceHeader
                  session={selectedSession}
                  resolvingSessionID={resolvingSelectedSessionID}
                  fallbackTitle="Preview"
                  errorMessage={error || streamError}
                  leadingAction={openSessionsButton}
                  headerActions={viewToggle}
                  onUpdateTitle={handleUpdateTitle}
                  onUpdateWorkspace={handleUpdateWorkspace}
                  hasUnsavedWorkspaceFile={workspaceFileDirty}
                  onUpdateAgentOptions={handleUpdateAgentOptions}
                  showDebugEvents={showDebugEvents}
                  onShowDebugEventsChange={handleShowDebugEventsChange}
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
                  onOpenWorkspaceDetails={() => setMobileRailOpen(true)}
                  clearPending={
                    selectedSession
                      ? pendingSessionAction?.sessionID === selectedSession.id &&
                        pendingSessionAction.action === 'clear'
                      : false
                  }
                  compactPending={
                    selectedSession
                      ? pendingSessionAction?.sessionID === selectedSession.id &&
                        pendingSessionAction.action === 'compact'
                      : false
                  }
                  archivePending={selectedSession ? archivingSessionID === selectedSession.id : false}
                />
              </div>
              <div
                data-testid="floating-host-header"
                className="pointer-events-none absolute inset-x-0 top-0 z-20 hidden p-3 lg:block"
              >
                <FilesWorkspaceHeader
                  session={selectedSession}
                  resolvingSessionID={resolvingSelectedSessionID}
                  fallbackTitle="Preview"
                  errorMessage={error || streamError}
                  headerActions={viewToggle}
                  onUpdateTitle={handleUpdateTitle}
                  onUpdateWorkspace={handleUpdateWorkspace}
                  hasUnsavedWorkspaceFile={workspaceFileDirty}
                  onUpdateAgentOptions={handleUpdateAgentOptions}
                  showDebugEvents={showDebugEvents}
                  onShowDebugEventsChange={handleShowDebugEventsChange}
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
                  onOpenWorkspaceDetails={() => setMobileRailOpen(true)}
                  clearPending={
                    selectedSession
                      ? pendingSessionAction?.sessionID === selectedSession.id &&
                        pendingSessionAction.action === 'clear'
                      : false
                  }
                  compactPending={
                    selectedSession
                      ? pendingSessionAction?.sessionID === selectedSession.id &&
                        pendingSessionAction.action === 'compact'
                      : false
                  }
                  archivePending={selectedSession ? archivingSessionID === selectedSession.id : false}
                />
              </div>
              <HostPreview session={selectedSession} resolvingSessionID={resolvingSelectedSessionID} />
            </>
          ) : appView === 'files' ? (
            <>
              <div
                data-testid="mobile-floating-files-header"
                className="mobile-floating-header-shell pointer-events-none absolute inset-x-0 z-20 p-3 lg:hidden"
              >
                <FilesWorkspaceHeader
                  session={selectedSession}
                  resolvingSessionID={resolvingSelectedSessionID}
                  errorMessage={error || streamError}
                  leadingAction={openSessionsButton}
                  headerActions={viewToggle}
                  onUpdateTitle={handleUpdateTitle}
                  onUpdateWorkspace={handleUpdateWorkspace}
                  hasUnsavedWorkspaceFile={workspaceFileDirty}
                  onUpdateAgentOptions={handleUpdateAgentOptions}
                  showDebugEvents={showDebugEvents}
                  onShowDebugEventsChange={handleShowDebugEventsChange}
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
                  onOpenWorkspaceDetails={() => setMobileRailOpen(true)}
                  clearPending={
                    selectedSession
                      ? pendingSessionAction?.sessionID === selectedSession.id &&
                        pendingSessionAction.action === 'clear'
                      : false
                  }
                  compactPending={
                    selectedSession
                      ? pendingSessionAction?.sessionID === selectedSession.id &&
                        pendingSessionAction.action === 'compact'
                      : false
                  }
                  archivePending={selectedSession ? archivingSessionID === selectedSession.id : false}
                />
              </div>
              <div
                data-testid="floating-files-header"
                className="pointer-events-none absolute inset-x-0 top-0 z-20 hidden p-3 lg:block"
              >
                <FilesWorkspaceHeader
                  session={selectedSession}
                  resolvingSessionID={resolvingSelectedSessionID}
                  errorMessage={error || streamError}
                  headerActions={viewToggle}
                  onUpdateTitle={handleUpdateTitle}
                  onUpdateWorkspace={handleUpdateWorkspace}
                  hasUnsavedWorkspaceFile={workspaceFileDirty}
                  onUpdateAgentOptions={handleUpdateAgentOptions}
                  showDebugEvents={showDebugEvents}
                  onShowDebugEventsChange={handleShowDebugEventsChange}
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
                  onOpenWorkspaceDetails={() => setMobileRailOpen(true)}
                  clearPending={
                    selectedSession
                      ? pendingSessionAction?.sessionID === selectedSession.id &&
                        pendingSessionAction.action === 'clear'
                      : false
                  }
                  compactPending={
                    selectedSession
                      ? pendingSessionAction?.sessionID === selectedSession.id &&
                        pendingSessionAction.action === 'compact'
                      : false
                  }
                  archivePending={selectedSession ? archivingSessionID === selectedSession.id : false}
                />
              </div>
              <WorkspaceFilesView
                session={selectedSession}
                resolvingSessionID={resolvingSelectedSessionID}
                refreshKey={fileRefreshKey}
                selectedFile={openWorkspaceFile}
                resolvedTheme={theme.resolvedTheme}
                onOpenFile={handleOpenWorkspaceFile}
                onFileSaved={setOpenWorkspaceFile}
                onCloseFile={handleCloseWorkspaceFile}
                onDirtyChange={setWorkspaceFileDirty}
                focusedLine={focusedFileLine}
              />
            </>
          ) : (
            <SessionDetail
              session={selectedSession}
              resolvingSessionID={resolvingChatSessionID}
              events={events}
              liveEvents={liveEvents}
              streamState={streamState}
              hasOlderEvents={hasOlderEvents}
              hasNewerEvents={hasNewerEvents}
              loadingOlderEvents={loadingOlderEvents}
              loadingNewerEvents={loadingNewerEvents}
              onLoadOlderEvents={loadOlderEvents}
              onLoadNewerEvents={loadNewerEvents}
              onJumpToLatest={handleJumpToLatest}
              onFollowingTailChange={setFollowingTail}
              errorMessage={chatErrorMessage}
              showDebugEvents={showDebugEvents}
              onSubmitPrompt={handleSubmitPrompt}
              onAnswerUserInput={handleAnswerUserInput}
              onResolvePermission={handleResolvePermission}
              onCancel={handleCancel}
              onOpenFilePath={handleOpenWorkspacePath}
              onComposerFocus={handleComposerFocus}
              composerFocusRequest={composerFocusRequest}
              onErrorMessageChange={setError}
              focusedEventSeq={focusedEventSeq}
              focusedEventRequest={focusedEventRequest}
              onVisibleSequenceRangeChange={setTranscriptVisibleRange}
              headerActions={viewToggle}
              mobileLeadingAction={openSessionsButton}
            />
          )}
        </div>
      </section>

      {!isGlobalView ? (
        <PaneResizeHandle
          label="Resize details pane"
          value={paneWidths.right}
          min={paneLimits.rightMin}
          max={paneLimits.rightMax}
          onPointerDown={(event) => beginPaneResize('right', event)}
          onKeyDown={(event) => handlePaneResizeKey('right', event)}
        />
      ) : null}

      <div
        className={cn('min-h-0 shrink-0', isGlobalView ? 'hidden' : 'hidden lg:flex')}
        style={paneWidthStyle(paneWidths.right)}
      >
        <RunHealthRail
          session={selectedSession}
          resolvingSessionID={resolvingSelectedSessionID}
          events={events}
          activityEvents={liveEvents}
          streamState={streamState}
          streamError={streamError}
          fileRefreshKey={fileRefreshKey}
          contentMode={railContent.mode}
          onContentModeChange={railContent.setMode}
          contentActive={!isGlobalView}
          hasOlderEvents={hasOlderEvents}
          hasNewerEvents={hasNewerEvents}
          loadingOlderEvents={loadingOlderEvents}
          loadingNewerEvents={loadingNewerEvents}
          onLoadOlderEvents={loadOlderEvents}
          onLoadNewerEvents={loadNewerEvents}
          onJumpToLatest={handleJumpToLatest}
          visibleSequenceRange={transcriptVisibleRange}
          focusedEventSeq={focusedEventSeq}
          onSelectConversationSeq={handleSelectConversationSeq}
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
          onOpenFile={handleOpenWorkspaceFile}
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
      <SpotlightSearch
        open={spotlightOpen}
        sessionID={selectedSessionID}
        onOpenChange={setSpotlightOpen}
        onSelect={(result) => void handleSpotlightResult(result)}
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
      <Dialog open={mobileListOpen} onOpenChange={setMobileListOpen}>
        <DialogContent
          showClose={false}
          className="command-chat-header grid max-h-[min(42rem,calc(100dvh-4rem))] w-[calc(100vw-1.5rem)] max-w-md grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden border-border/90 p-0 shadow-[0_18px_60px_hsl(var(--foreground)/0.18)]"
        >
          <DialogHeader className="border-b border-border/70 p-4">
            <div className="flex items-center justify-between gap-3">
              <DialogTitle>Sessions</DialogTitle>
              <div className="flex shrink-0 items-center gap-2">
                {renderNotificationsPopover()}
                {renderAppMenu()}
                <Button
                  type="button"
                  aria-label="Create session"
                  size="icon"
                  onClick={() => {
                    setMobileListOpen(false)
                    setCreateOpen(true)
                  }}
                  className="shadow-sm"
                >
                  <Plus />
                </Button>
                <DialogClose asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Close"
                    className="text-muted-foreground hover:bg-background/50 hover:text-foreground"
                  >
                    <X />
                  </Button>
                </DialogClose>
              </div>
            </div>
          </DialogHeader>
          <div className="min-h-0 overflow-hidden">{mobileList}</div>
        </DialogContent>
      </Dialog>
      <Dialog open={mobileRailOpen} onOpenChange={setMobileRailOpen}>
        <DialogContent
          showClose={false}
          className="command-chat-header grid max-h-[min(44rem,calc(100dvh-4rem))] w-[calc(100vw-1.5rem)] max-w-md grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden border-border/90 p-0 shadow-[0_18px_60px_hsl(var(--foreground)/0.18)] lg:hidden"
        >
          <DialogHeader className="border-b border-border/70 p-4">
            <div className="flex items-center justify-between gap-3">
              <DialogTitle>Workspace details</DialogTitle>
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Close workspace details"
                  className="text-muted-foreground hover:bg-background/50 hover:text-foreground"
                >
                  <X />
                </Button>
              </DialogClose>
            </div>
          </DialogHeader>
          <div className="min-h-0 overflow-hidden">
            <RunHealthRail
              session={selectedSession}
              resolvingSessionID={resolvingSelectedSessionID}
              events={events}
              streamState={streamState}
              streamError={streamError}
              fileRefreshKey={fileRefreshKey}
              showUtilityContent={false}
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
              onOpenFile={handleOpenWorkspaceFile}
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
        </DialogContent>
      </Dialog>
      <CreateSessionDialog open={createOpen} onOpenChange={setCreateOpen} onCreate={handleCreate} />
      {viewportDebug ? <ViewportDebugPanel /> : null}
    </main>
  )
}

function SessionViewNavigation({
  session,
  view,
  onSelect,
  onOpenWorkspaceDetails,
  onClear,
  onCompact,
  onToggleArchive,
  clearPending,
  compactPending,
  archivePending,
}: {
  session: Session | null
  view: AppView
  onSelect: (view: AppView) => void
  onOpenWorkspaceDetails: () => void
  onClear: () => void
  onCompact: () => void
  onToggleArchive: () => void
  clearPending: boolean
  compactPending: boolean
  archivePending: boolean
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const { triggerRef, popoverStyle } = useAnchoredPopover(open, 288)
  const views: Array<{ view: AppView; label: string; shortLabel: string; icon: ReactNode }> = [
    { view: 'session', label: 'Show chat', shortLabel: 'Chat', icon: <MessageSquare className="size-4" /> },
    { view: 'console', label: 'Show console', shortLabel: 'Console', icon: <Terminal className="size-4" /> },
    { view: 'schedules', label: 'Show schedules', shortLabel: 'Scheduled tasks', icon: <CalendarClock className="size-4" /> },
    { view: 'skills', label: 'Show repository skills', shortLabel: 'Repository skills', icon: <BookOpen className="size-4" /> },
    { view: 'files', label: 'Show files', shortLabel: 'Files', icon: <Folder className="size-4" /> },
    { view: 'host', label: 'Show hosted preview', shortLabel: 'Hosted preview', icon: <Server className="size-4" /> },
    { view: 'settings', label: 'Show session settings', shortLabel: 'Session settings', icon: <Settings className="size-4" /> },
  ]
  const activeIndex = Math.max(0, views.findIndex((item) => item.view === view))
  const actionPending = clearPending || compactPending || archivePending
  const codexActionDisabled =
    !session || session.agent_type !== 'codex' || session.status === 'running' || Boolean(session.archived_at) || actionPending
  const compactDisabled = codexActionDisabled || !session?.provider_session_id
  const archiveDisabled = !session || session.status === 'running' || archivePending

  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  function select(nextView: AppView) {
    setOpen(false)
    onSelect(nextView)
  }

  return (
    <>
      <div className="relative hidden shrink-0 grid-cols-7 rounded-md bg-muted p-1 shadow-inner lg:grid">
        <span
          aria-hidden="true"
          className="absolute bottom-1 left-1 top-1 w-8 rounded-sm bg-background shadow-sm transition-transform duration-150 ease-out"
          style={{ transform: `translateX(${activeIndex * 2}rem)` }}
        />
        {views.map((item) => (
          <button
            key={item.view}
            type="button"
            aria-label={item.label}
            aria-pressed={view === item.view}
            className={cn(
              'relative z-10 flex h-8 w-8 items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              view === item.view ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => select(item.view)}
          >
            {item.icon}
          </button>
        ))}
      </div>
      <div ref={menuRef} className="relative shrink-0 lg:hidden">
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 text-muted-foreground hover:bg-background/50 hover:text-foreground"
          aria-label="More session actions"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
        {open ? (
          <div role="menu" aria-label="Session navigation and actions" style={popoverStyle} className="z-50 overflow-y-auto rounded-lg border border-border/80 bg-popover p-1.5 text-sm text-popover-foreground shadow-lg">
            <p className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Views</p>
            {views.map((item) => (
              <button
                key={item.view}
                type="button"
                role="menuitem"
                aria-current={view === item.view ? 'page' : undefined}
                className={cn('flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground', view === item.view && 'bg-accent/65 text-accent-foreground')}
                onClick={() => select(item.view)}
              >
                {item.icon}<span className="flex-1">{item.shortLabel}</span>
              </button>
            ))}
            <div className="my-1 border-t border-border/70" />
            <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground" onClick={() => { setOpen(false); onOpenWorkspaceDetails() }}>
              <PanelRightOpen className="size-4" /><span>Workspace details</span>
            </button>
            <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-45" disabled={codexActionDisabled} onClick={() => { setOpen(false); onClear() }}>
              {clearPending ? <Loader2 className="size-4 animate-spin" /> : <Eraser className="size-4" />}<span>{clearPending ? 'Clearing' : 'Clear context'}</span>
            </button>
            <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-45" disabled={compactDisabled} onClick={() => { setOpen(false); onCompact() }}>
              {compactPending ? <Loader2 className="size-4 animate-spin" /> : <Minimize2 className="size-4" />}<span>{compactPending ? 'Compacting' : 'Compact context'}</span>
            </button>
            <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-destructive hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-45" disabled={archiveDisabled} onClick={() => { setOpen(false); onToggleArchive() }}>
              {archivePending ? <Loader2 className="size-4 animate-spin" /> : <Archive className="size-4" />}
              <span>{archivePending ? (session?.archived_at ? 'Restoring' : 'Archiving') : session?.archived_at ? 'Restore session' : 'Archive session'}</span>
            </button>
          </div>
        ) : null}
      </div>
    </>
  )
}

function FilesWorkspaceHeader({
  session,
  resolvingSessionID,
  fallbackTitle = 'Files',
  errorMessage,
  leadingAction,
  headerActions,
}: {
  session: Session | null
  resolvingSessionID: string | null
  fallbackTitle?: string
  errorMessage: string
  leadingAction?: ReactNode
  headerActions?: ReactNode
  onUpdateTitle: (title: string) => Promise<void>
  onUpdateWorkspace: (workspacePath: string) => Promise<void>
  hasUnsavedWorkspaceFile: boolean
  onUpdateAgentOptions: (agentOptions: SessionAgentOptions) => Promise<void>
  showDebugEvents: boolean
  onShowDebugEventsChange: (showDebugEvents: boolean) => void
  onClear?: () => Promise<void>
  onCompact?: () => Promise<void>
  onToggleArchive?: () => Promise<void>
  onOpenWorkspaceDetails?: () => void
  clearPending?: boolean
  compactPending?: boolean
  archivePending?: boolean
}) {
  if (session) {
    return (
      <ChatSessionHeader
        session={session}
        errorMessage={errorMessage}
        headerActions={headerActions}
        leadingAction={leadingAction}
      />
    )
  }

  return (
    <div className="pointer-events-auto">
      <div className="command-chat-header flex min-h-14 items-center justify-between gap-3 rounded-xl border border-border/90 px-3 py-2 shadow-[0_10px_30px_hsl(var(--foreground)/0.10)]">
        {leadingAction ? <div className="shrink-0">{leadingAction}</div> : null}
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-semibold">{resolvingSessionID ? 'Loading session...' : fallbackTitle}</p>
        </div>
        {headerActions}
      </div>
    </div>
  )
}

function ViewportDebugPanel() {
  const probeRef = useRef<HTMLDivElement | null>(null)
  const [snapshot, setSnapshot] = useState<ViewportDebugSnapshot>(() => viewportDebugSnapshot(null))

  useEffect(() => {
    const visualViewport = window.visualViewport

    function updateSnapshot() {
      setSnapshot(viewportDebugSnapshot(probeRef.current))
    }

    updateSnapshot()
    window.addEventListener('resize', updateSnapshot)
    window.addEventListener('orientationchange', updateSnapshot)
    window.addEventListener('scroll', updateSnapshot, { passive: true })
    visualViewport?.addEventListener('resize', updateSnapshot)
    visualViewport?.addEventListener('scroll', updateSnapshot)

    const timer = window.setInterval(updateSnapshot, 1000)
    return () => {
      window.removeEventListener('resize', updateSnapshot)
      window.removeEventListener('orientationchange', updateSnapshot)
      window.removeEventListener('scroll', updateSnapshot)
      visualViewport?.removeEventListener('resize', updateSnapshot)
      visualViewport?.removeEventListener('scroll', updateSnapshot)
      window.clearInterval(timer)
    }
  }, [])

  return (
    <>
      <div
        ref={probeRef}
        aria-hidden="true"
        className="pointer-events-none fixed left-0 top-0 h-0 w-0 overflow-hidden"
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      />
      <div className="fixed inset-x-2 bottom-2 z-[100] rounded-lg border border-amber-300/60 bg-background/92 p-2 font-mono text-[11px] leading-4 text-foreground shadow-xl backdrop-blur">
        <div className="mb-1 flex items-center justify-between gap-2 font-sans text-xs font-semibold">
          <span>Viewport debug</span>
          <span className="text-muted-foreground">remove param to hide</span>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
          {Object.entries(snapshot).map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="truncate">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </>
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
            <Button
              type="button"
              variant={isArchived ? 'default' : 'destructive'}
              disabled={pending}
              onClick={onConfirm}
            >
              {pending ? (isArchived ? 'Restoring' : 'Archiving') : isArchived ? 'Restore' : 'Archive'}
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

function preferFresherSessionSnapshots(incoming: Session[], current: Session[]) {
  const currentByID = new Map(current.map((session) => [session.id, session]))
  return incoming.map((session) => {
    const existing = currentByID.get(session.id)
    return existing && latestSessionSeq(existing) > latestSessionSeq(session) ? existing : session
  })
}

function addSetValue(current: ReadonlySet<string>, value: string | null) {
  if (!value || current.has(value)) {
    return current
  }
  return new Set([...current, value])
}

function removeSetValue(current: ReadonlySet<string>, value: string) {
  if (!current.has(value)) {
    return current
  }
  const next = new Set(current)
  next.delete(value)
  return next
}

function applySessionEvent(session: Session, event: AgentEvent, status: SessionStatus | null) {
  const currentLastSeq = latestSessionSeq(session)
  if (event.seq <= currentLastSeq) {
    return session
  }
  const nextLastSeq = Math.max(currentLastSeq, event.seq)
  const eventCount = (session.event_count ?? 0) + (isTransientEvent(event) ? 0 : 1)
  const toolCount = (session.tool_count ?? 0) + (isToolActivityEvent(event) ? 1 : 0)
  const tokenCount = Math.max(session.token_count ?? 0, payloadNumber(event.payload, 'session_total_tokens') ?? 0)
  const pendingInput = pendingInputFromEvent(session.pending_input ?? false, event)
  const pendingPermissionCount = pendingPermissionCountFromEvent(session.pending_permission_count ?? 0, event)
  if (!status) {
    return {
      ...session,
      event_count: eventCount,
      last_event_seq: nextLastSeq,
      tool_count: toolCount,
      token_count: tokenCount,
      pending_input: pendingInput,
      pending_permission_count: pendingPermissionCount,
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
    token_count: tokenCount,
    pending_input: pendingInput,
    pending_permission_count: pendingPermissionCount,
    updated_at: updatedAt,
    completed_at: completedAt,
  }
}

function pendingPermissionCountFromEvent(current: number, event: AgentEvent) {
  if (event.type === 'agent.permission.requested') return current + 1
  if (event.type === 'agent.permission.resolved' || event.type === 'agent.permission.cancelled')
    return Math.max(0, current - 1)
  if (isTerminalEvent(event.type)) return 0
  return current
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

function payloadNumber(payload: unknown, key: string) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null
  }
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function sortSessions(sessions: Session[]) {
  return [...sessions].sort((left, right) => {
    const byUpdated = new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
    return byUpdated !== 0 ? byUpdated : right.id.localeCompare(left.id)
  })
}

function notificationDetailsForEvent(event: AgentEvent, events: AgentEvent[], sessions: Session[]) {
  const session = sessions.find((item) => item.id === event.session_id)
  return {
    title: session?.title,
    excerpt: latestAgentMessageExcerpt(events),
  }
}

function latestAgentMessageExcerpt(events: AgentEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'agent.message.completed') {
      continue
    }
    const excerpt = notificationExcerpt(payloadText(event.payload))
    if (excerpt) {
      return excerpt
    }
  }
  return ''
}

function notificationExcerpt(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return ''
  }
  const clipped = words.slice(0, 18).join(' ')
  return words.length > 18 ? `${clipped}...` : clipped
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

function workspaceRelativeFilePath(path: string, workspacePath: string) {
  const filePath = path
    .trim()
    .replaceAll('\\', '/')
    .replace(/:\d+(?::\d+)?$/, '')
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

function applyNotificationAttentionSeqs(
  seenSeqs: Record<string, number>,
  notificationSeqs: Record<string, number>,
): Record<string, number> {
  let next = seenSeqs
  for (const [sessionID, seq] of Object.entries(notificationSeqs)) {
    if (!sessionID || !Number.isFinite(seq) || seq <= 0) {
      continue
    }
    const heldSeenSeq = Math.max(0, seq - 1)
    if ((next[sessionID] ?? 0) <= heldSeenSeq) {
      continue
    }
    if (next === seenSeqs) {
      next = { ...seenSeqs }
    }
    if (heldSeenSeq > 0) {
      next[sessionID] = heldSeenSeq
    } else {
      delete next[sessionID]
    }
  }
  return next
}

function notificationAttentionSeqsFromSessions(sessions: Session[]): Record<string, number> {
  const seqs: Record<string, number> = {}
  for (const session of sessions) {
    const seq = Number(session.notification_attention_seq)
    if (session.id && Number.isFinite(seq) && seq > 0) {
      seqs[session.id] = Math.max(seqs[session.id] ?? 0, seq)
    }
  }
  return seqs
}

function mergeNotificationAttentionSeqs(
  first: Record<string, number>,
  second: Record<string, number>,
): Record<string, number> {
  const merged: Record<string, number> = {}
  for (const source of [first, second]) {
    for (const [sessionID, value] of Object.entries(source)) {
      const seq = Number(value)
      if (sessionID && Number.isFinite(seq) && seq > 0) {
        merged[sessionID] = Math.max(merged[sessionID] ?? 0, seq)
      }
    }
  }
  return merged
}

function notificationAttentionFromLocation(): {
  sessionID: string
  seq: number
} | null {
  if (typeof window === 'undefined') {
    return null
  }
  const route = selectedSessionRouteFromLocation()
  if (!route.sessionID) {
    return null
  }
  const seq = Number(new URLSearchParams(window.location.search).get('notification_seq'))
  if (!Number.isFinite(seq) || seq <= 0) {
    return null
  }
  return { sessionID: route.sessionID, seq }
}

function clearNotificationAttentionSearchParam() {
  if (typeof window === 'undefined') {
    return
  }
  const params = new URLSearchParams(window.location.search)
  if (!params.has('notification_seq')) {
    return
  }
  params.delete('notification_seq')
  const nextSearch = params.toString()
  const nextURL = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
  window.history.replaceState({}, '', nextURL)
}

function debugStorageKey(sessionID: string) {
  return `${debugStorageKeyPrefix}${sessionID}`
}

function loadViewportDebugPreference() {
  if (typeof window === 'undefined') {
    return false
  }

  const value = new URLSearchParams(window.location.search).get('viewportDebug')
  return value === '1' || value === 'true'
}

function viewportDebugSnapshot(probe: HTMLElement | null): ViewportDebugSnapshot {
  const visualViewport = window.visualViewport
  const documentElement = document.documentElement
  const appRect = document.querySelector('.app-shell')?.getBoundingClientRect()
  const safeTop = probe ? window.getComputedStyle(probe).paddingTop : 'n/a'

  return {
    inner: `${Math.round(window.innerWidth)} x ${Math.round(window.innerHeight)}`,
    outer: `${Math.round(window.outerWidth)} x ${Math.round(window.outerHeight)}`,
    documentElement: `${Math.round(documentElement.clientWidth)} x ${Math.round(documentElement.clientHeight)}`,
    visualViewport: visualViewport
      ? `${Math.round(visualViewport.width)} x ${Math.round(visualViewport.height)} scale ${round2(visualViewport.scale)}`
      : 'n/a',
    visualOffset: visualViewport
      ? `top ${round2(visualViewport.offsetTop)} pageTop ${round2(visualViewport.pageTop)}`
      : 'n/a',
    scroll: `${round2(window.scrollX)}, ${round2(window.scrollY)}`,
    safeTop,
    appRect: appRect
      ? `top ${round2(appRect.top)} bottom ${round2(appRect.bottom)} height ${round2(appRect.height)}`
      : 'n/a',
    screen: `${window.screen.width} x ${window.screen.height} avail ${window.screen.availHeight}`,
    dpr: String(round2(window.devicePixelRatio)),
  }
}

function round2(value: number) {
  return Math.round(value * 100) / 100
}

function loadInitialSessionStateFromLocation(): InitialSessionState {
  const route = selectedSessionRouteFromLocation()
  const cachedSession = cachedSessionForRoute(route)
  if (cachedSession) {
    return {
      sessions: [cachedSession],
      selectedSessionID: cachedSession.id,
      seededCachedSession: true,
    }
  }
  return {
    sessions: [],
    selectedSessionID: route.sessionID,
    seededCachedSession: false,
  }
}

function cachedSessionForRoute(route: SessionRoute) {
  if (route.sessionID) {
    return readCachedSessionSnapshot(route.sessionID)
  }
  if (route.sessionSlug) {
    return readCachedSessionSnapshotBySlug(route.sessionSlug)
  }
  return null
}

function selectedSessionRouteFromLocation() {
  if (typeof window === 'undefined') {
    return {
      sessionID: null,
      sessionSlug: null,
      view: 'session' as const,
      filePath: null,
    }
  }
  return sessionRouteFromPathname(window.location.pathname)
}

function eventSequenceFromLocation() {
  return positiveLocationSearchNumber('event_seq')
}

function fileLineFromLocation() {
  return positiveLocationSearchNumber('line')
}

function positiveLocationSearchNumber(name: string) {
  if (typeof window === 'undefined') return 0
  const value = Number.parseInt(new URLSearchParams(window.location.search).get(name) ?? '', 10)
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

function isSessionLocation() {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/sessions/')
}

function isUserSkillsLocation() {
  return typeof window !== 'undefined' && window.location.pathname === '/skills'
}

function resolveSessionRouteSessionID(route: SessionRoute, sessions: Session[]) {
  if (route.sessionID) {
    return route.sessionID
  }
  if (!route.sessionSlug) {
    return null
  }
  return sessions.find((session) => sessionTitleSlug(session.title) === route.sessionSlug)?.id ?? null
}

function writeSelectedSessionRoute(
  sessionID: string | null,
  historyMode: Exclude<SessionRouteHistoryMode, 'none'>,
  view: AppView = 'session',
  sessions: Session[] = [],
  filePath: string | null = null,
) {
  if (typeof window === 'undefined') {
    return
  }

  const currentRoute = selectedSessionRouteFromLocation()
  const routeSession = sessionID ? sessions.find((session) => session.id === sessionID) : null
  const currentRouteSessionID = resolveSessionRouteSessionID(currentRoute, sessions)
  const path = routeSession
    ? sessionSlugPath(sessionTitleSlug(routeSession.title), view, filePath)
    : currentRoute.sessionSlug && currentRouteSessionID === sessionID
      ? sessionSlugPath(currentRoute.sessionSlug, view, filePath)
      : sessionPath(sessionID, view, filePath)
  if (window.location.pathname === path && window.location.search === '') {
    return
  }

  if (historyMode === 'replace') {
    window.history.replaceState({}, '', path)
    return
  }
  window.history.pushState({}, '', path)
}

function writeSpotlightResultRoute(
  session: Session,
  view: AppView,
  filePath: string | null,
  target: { eventSeq?: number; line?: number },
) {
  if (typeof window === 'undefined') return
  const path = sessionSlugPath(sessionTitleSlug(session.title), view, filePath)
  const params = new URLSearchParams()
  if (target.eventSeq && target.eventSeq > 0) params.set('event_seq', String(target.eventSeq))
  if (target.line && target.line > 0) params.set('line', String(target.line))
  const url = params.size > 0 ? `${path}?${params}` : path
  if (`${window.location.pathname}${window.location.search}` === url) return
  window.history.pushState({}, '', url)
}

export default App
