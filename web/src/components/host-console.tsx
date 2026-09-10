import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Loader2, RefreshCw, Square, Terminal } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@/lib/api'
import { consoleWebSocketURL, getConsoleStatus, killConsole } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { SessionTitle } from '@/components/session-title-editor'
import { cn } from '@/lib/utils'

export type ConsoleActions = {
  pending: boolean
  onRestart: () => void
  onStop: () => void
}

type ConsoleMessage = {
  type: string
  data?: string
  code?: number | null
  message?: string
}

export function HostConsole({
  session,
  resolvingSessionID = null,
  resolvedTheme,
  headerActions,
  mobileLeadingAction,
}: {
  session: Session | null
  resolvingSessionID?: string | null
  resolvedTheme: 'light' | 'dark'
  headerActions?: ReactNode | ((actions: ConsoleActions) => ReactNode)
  mobileLeadingAction?: ReactNode
}) {
  const terminalElementRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [restartKey, setRestartKey] = useState(0)
  const [restarting, setRestarting] = useState(false)
  const [stopping, setStopping] = useState(false)

  const sessionID = session?.id ?? ''

  const fit = useCallback(() => {
    const fitAddon = fitAddonRef.current
    const socket = socketRef.current
    if (!fitAddon || !terminalRef.current) {
      return
    }
    try {
      fitAddon.fit()
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: terminalRef.current.cols, rows: terminalRef.current.rows }))
      }
    } catch {
      // xterm can throw while layout is settling during mount/unmount.
    }
  }, [])

  useEffect(() => {
    setErrorMessage('')
    if (!sessionID) {
      return
    }

    let cancelled = false
    void getConsoleStatus(sessionID).catch((error: unknown) => {
        if (!cancelled) {
          setErrorMessage(messageFromUnknown(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [sessionID, restartKey])

  useEffect(() => {
    const element = terminalElementRef.current
    if (!element || !sessionID) {
      return
    }

    setErrorMessage('')
    const terminal = new XTerm({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      theme:
        resolvedTheme === 'dark'
          ? {
              background: '#070b12',
              foreground: '#dbe4ee',
              cursor: '#5eead4',
              selectionBackground: '#334155',
            }
          : {
              background: '#f8fafc',
              foreground: '#111827',
              cursor: '#0f766e',
              selectionBackground: '#cbd5e1',
            },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(element)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    let disposed = false
    let socket: WebSocket | null = null
    const connectTimer = window.setTimeout(() => {
      if (disposed) {
        return
      }
      socket = new WebSocket(consoleWebSocketURL(sessionID))
      socketRef.current = socket

      socket.addEventListener('open', () => {
        if (!disposed) {
          fit()
        }
      })
      socket.addEventListener('message', (event: MessageEvent<string>) => {
        if (disposed) {
          return
        }
        const message = parseConsoleMessage(event.data)
        if (!message) {
          return
        }
        if (message.type === 'output' && message.data) {
          terminal.write(message.data)
        }
        if (message.type === 'error') {
          setErrorMessage(message.message || 'Console connection failed')
        }
        if (message.type === 'exit') {
          setErrorMessage('Console exited.')
        }
      })
      socket.addEventListener('error', () => {
        if (!disposed) {
          setErrorMessage('Console connection failed')
        }
      })
    }, 0)

    const dataDisposable = terminal.onData((data) => {
      const activeSocket = socketRef.current
      if (activeSocket?.readyState === WebSocket.OPEN) {
        activeSocket.send(JSON.stringify({ type: 'input', data }))
      }
    })

    const resizeObserver = new ResizeObserver(fit)
    resizeObserver.observe(element)
    reconnectTimerRef.current = window.setTimeout(fit, 0)

    return () => {
      disposed = true
      window.clearTimeout(connectTimer)
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      resizeObserver.disconnect()
      dataDisposable.dispose()
      if (socket?.readyState === WebSocket.CONNECTING) {
        socket.addEventListener('open', () => socket?.close(), { once: true })
      } else {
        socket?.close()
      }
      if (socketRef.current === socket) {
        socketRef.current = null
      }
      terminal.dispose()
      if (terminalRef.current === terminal) {
        terminalRef.current = null
      }
      if (fitAddonRef.current === fitAddon) {
        fitAddonRef.current = null
      }
    }
  }, [fit, resolvedTheme, restartKey, sessionID])

  async function handleRestart() {
    if (!sessionID || restarting || stopping) {
      return
    }
    setRestarting(true)
    setErrorMessage('')
    try {
      await killConsole(sessionID)
    } catch {
      // Restart should also work when there is no existing console.
    } finally {
      setRestarting(false)
      setRestartKey((value) => value + 1)
    }
  }

  async function handleStop() {
    if (!sessionID || restarting || stopping) return
    setStopping(true)
    setErrorMessage('')
    try {
      await killConsole(sessionID)
    } catch (error) {
      setErrorMessage(messageFromUnknown(error))
    } finally {
      setStopping(false)
    }
  }

  const consoleActions: ConsoleActions = {
    pending: restarting || stopping,
    onRestart: () => void handleRestart(),
    onStop: () => void handleStop(),
  }
  const navigation = typeof headerActions === 'function' ? headerActions(consoleActions) : headerActions

  if (!session) {
    if (resolvingSessionID) {
      return (
        <div className="flex h-full w-full min-h-0 items-center justify-center bg-background p-8 text-center">
          <div>
            <Loader2 className="mx-auto mb-3 size-6 animate-spin text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">Loading session...</p>
            <p className="mt-1 text-xs text-muted-foreground">Restoring the selected console from the route.</p>
          </div>
        </div>
      )
    }

    return (
      <div className="flex h-full w-full min-h-0 items-center justify-center bg-background">
        <div className="text-center">
          <Terminal className="mx-auto mb-3 size-8 text-muted-foreground" />
          <p className="text-sm font-medium">Select a session to open a console.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex h-full w-full min-h-0 flex-col bg-background">
      <div className="mobile-floating-header-shell pointer-events-none absolute inset-x-0 z-20 p-3 lg:hidden">
        <ConsoleHeader
          session={session}
          restarting={restarting}
          actions={consoleActions}
          mobile
          leadingAction={mobileLeadingAction}
          headerActions={navigation}
          className="command-chat-header pointer-events-auto rounded-xl border border-border/90 px-3 shadow-[0_10px_30px_hsl(var(--foreground)/0.10)]"
        />
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 hidden p-3 lg:block">
        <ConsoleHeader
          session={session}
          restarting={restarting}
          actions={consoleActions}
          headerActions={navigation}
          className="command-chat-header pointer-events-auto rounded-xl border border-border/90 px-3 shadow-[0_10px_30px_hsl(var(--foreground)/0.10)]"
        />
      </div>
      {errorMessage ? (
        <div className="mx-3 mt-36 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive lg:mt-[4.75rem]">
          {errorMessage}
        </div>
      ) : null}
      <div
        data-testid="host-console-frame"
        className={cn('min-h-0 flex-1 p-2 lg:px-3 lg:pb-3', !errorMessage && 'host-console-frame')}
      >
        <div ref={terminalElementRef} className="host-console h-full min-h-0 overflow-hidden rounded-xl border border-border/90" />
      </div>
    </div>
  )
}

function ConsoleHeader({
  session,
  restarting,
  actions,
  mobile = false,
  leadingAction,
  headerActions,
  className,
}: {
  session: Session
  restarting: boolean
  actions: ConsoleActions
  mobile?: boolean
  leadingAction?: ReactNode
  headerActions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex min-h-14 shrink-0 items-center justify-between gap-3 py-2', className)}>
      {leadingAction ? <div className="shrink-0">{leadingAction}</div> : null}
      <div className="min-w-0 flex-1">
        <SessionTitle title={session.title} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {!mobile ? <>
          <Button type="button" size="icon" variant="ghost" aria-label="Restart console" title="Restart console" disabled={actions.pending} onClick={actions.onRestart} className="h-8 w-8 text-muted-foreground hover:text-foreground">
            <RefreshCw className={cn(restarting && 'animate-spin')} aria-hidden="true" />
          </Button>
          <Button type="button" size="icon" variant="ghost" aria-label="Stop console" title="Stop console" disabled={actions.pending} onClick={actions.onStop} className="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive">
            <Square aria-hidden="true" />
          </Button>
        </> : null}
        {headerActions}
      </div>
    </div>
  )
}

function parseConsoleMessage(data: string): ConsoleMessage | null {
  try {
    return JSON.parse(data) as ConsoleMessage
  } catch {
    return null
  }
}

function messageFromUnknown(error: unknown) {
  return error instanceof Error ? error.message : 'Console request failed'
}
