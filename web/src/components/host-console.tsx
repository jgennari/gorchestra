import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Ellipsis, RefreshCw, Square, Terminal } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@/lib/api'
import { consoleWebSocketURL, getConsoleStatus, killConsole, type ConsoleStatus } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { SessionTitleEditor } from '@/components/session-title-editor'
import { cn } from '@/lib/utils'

type ConsoleMessage = {
  type: string
  data?: string
  code?: number | null
  message?: string
}

export function HostConsole({
  session,
  resolvedTheme,
  headerActions,
  onUpdateTitle,
  onTitleEditStateChange,
}: {
  session: Session | null
  resolvedTheme: 'light' | 'dark'
  headerActions?: ReactNode
  onUpdateTitle: (title: string) => Promise<void>
  onTitleEditStateChange?: (state: { editorID: string; editing: boolean; dirty: boolean }) => void
}) {
  const terminalElementRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const [status, setStatus] = useState<ConsoleStatus | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [restartKey, setRestartKey] = useState(0)
  const [restarting, setRestarting] = useState(false)

  const sessionID = session?.id ?? ''
  const workspacePath = status?.workspace_path || session?.workspace_path || ''

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
    setStatus(null)
    setErrorMessage('')
    if (!sessionID) {
      return
    }

    let cancelled = false
    void getConsoleStatus(sessionID)
      .then((nextStatus) => {
        if (!cancelled) {
          setStatus(nextStatus)
        }
      })
      .catch((error: unknown) => {
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
    if (!sessionID) {
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

  if (!session) {
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
      <ConsoleHeader
        session={session}
        workspacePath={workspacePath}
        restarting={restarting}
        headerActions={headerActions}
        onRestart={() => void handleRestart()}
        onStop={() => void killConsole(sessionID)}
        onUpdateTitle={onUpdateTitle}
        onTitleEditStateChange={onTitleEditStateChange}
        className="border-b bg-background px-3 lg:hidden"
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 hidden p-3 lg:block">
        <ConsoleHeader
          session={session}
          workspacePath={workspacePath}
          restarting={restarting}
          headerActions={headerActions}
          onRestart={() => void handleRestart()}
          onStop={() => void killConsole(sessionID)}
          onUpdateTitle={onUpdateTitle}
          onTitleEditStateChange={onTitleEditStateChange}
          className="command-chat-header pointer-events-auto rounded-xl border border-border/90 px-3 shadow-[0_10px_30px_hsl(var(--foreground)/0.10)]"
        />
      </div>
      {errorMessage ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive lg:mx-3 lg:mt-[4.75rem] lg:rounded-xl lg:border">
          {errorMessage}
        </div>
      ) : null}
      <div className={cn('min-h-0 flex-1 p-2 lg:px-3 lg:pb-3', !errorMessage && 'lg:pt-[4.75rem]')}>
        <div ref={terminalElementRef} className="host-console h-full min-h-0 overflow-hidden rounded-xl border border-border/90" />
      </div>
    </div>
  )
}

function ConsoleHeader({
  session,
  workspacePath,
  restarting,
  headerActions,
  onRestart,
  onStop,
  onUpdateTitle,
  onTitleEditStateChange,
  className,
}: {
  session: Session
  workspacePath: string
  restarting: boolean
  headerActions?: ReactNode
  onRestart: () => void
  onStop: () => void
  onUpdateTitle: (title: string) => Promise<void>
  onTitleEditStateChange?: (state: { editorID: string; editing: boolean; dirty: boolean }) => void
  className?: string
}) {
  return (
    <div className={cn('flex min-h-14 shrink-0 items-center justify-between gap-3 py-2', className)}>
      <div className="min-w-0 flex-1">
        <SessionTitleEditor
          key={`console-${session.id}`}
          title={session.title}
          onSave={onUpdateTitle}
          onEditStateChange={onTitleEditStateChange}
        />
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {headerActions}
        <ConsoleMenu workspacePath={workspacePath} restarting={restarting} onRestart={onRestart} onStop={onStop} />
      </div>
    </div>
  )
}

function ConsoleMenu({
  workspacePath,
  restarting,
  onRestart,
  onStop,
}: {
  workspacePath: string
  restarting: boolean
  onRestart: () => void
  onStop: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return

    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div ref={menuRef} className="relative shrink-0">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-8 w-8 text-muted-foreground hover:bg-background/50 hover:text-foreground"
        aria-label="Console actions"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Ellipsis />
      </Button>
      {open ? (
        <div className="absolute right-0 top-full z-50 mt-2 min-w-64 rounded-lg border border-border/80 bg-popover p-3 text-sm text-popover-foreground shadow-lg">
          <div className="border-b px-2 pb-2">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Workspace</p>
            <p className="mt-1 truncate text-xs text-muted-foreground" title={workspacePath}>
              {workspacePath || 'Unavailable'}
            </p>
          </div>
          <button
            type="button"
            className="mt-2 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground"
            disabled={restarting}
            onClick={() => {
              onRestart()
              setOpen(false)
            }}
          >
            <RefreshCw className={cn('size-4', restarting && 'animate-spin')} />
            Restart console
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-destructive hover:bg-destructive/10"
            onClick={() => {
              onStop()
              setOpen(false)
            }}
          >
            <Square className="size-4" />
            Stop console
          </button>
        </div>
      ) : null}
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
