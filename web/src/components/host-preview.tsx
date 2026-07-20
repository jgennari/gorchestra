import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileWarning,
  Loader2,
  Play,
  RefreshCw,
  RotateCw,
  Server,
  Square,
  Terminal,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  checkHost,
  getHostStatus,
  hostLogStreamURL,
  listHostLogs,
  restartHost,
  startHost,
  stopHost,
  validateHost,
  type HostLogChunk,
  type HostRuntimeState,
  type HostServiceState,
  type HostStatus,
  type Session,
} from '@/lib/api'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type HostAction = 'validate' | 'start' | 'stop' | 'restart' | 'check'
type StreamState = 'connecting' | 'open' | 'reconnecting' | 'closed'

const maxRenderedChunks = 4_000

export function HostPreview({
  session,
  resolvingSessionID = null,
}: {
  session: Session | null
  resolvingSessionID?: string | null
}) {
  const [status, setStatus] = useState<HostStatus | null>(null)
  const [logs, setLogs] = useState<HostLogChunk[]>([])
  const [loading, setLoading] = useState(false)
  const [logsReady, setLogsReady] = useState(false)
  const [logsTruncated, setLogsTruncated] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [action, setAction] = useState<HostAction | null>(null)
  const [serviceFilter, setServiceFilter] = useState('all')
  const [following, setFollowing] = useState(true)
  const [streamState, setStreamState] = useState<StreamState>('closed')
  const logViewportRef = useRef<HTMLDivElement | null>(null)
  const lastLogSeqRef = useRef(0)
  const loadGenerationRef = useRef(0)
  const activeSessionIDRef = useRef('')
  const sessionID = session?.id ?? ''

  useEffect(() => {
    activeSessionIDRef.current = sessionID
  }, [sessionID])

  const appendLogs = useCallback((incoming: HostLogChunk[]) => {
    if (incoming.length === 0) return
    setLogs((current) => mergeLogChunks(current, incoming))
    lastLogSeqRef.current = Math.max(lastLogSeqRef.current, ...incoming.map((chunk) => chunk.seq))
  }, [])

  const refreshStatus = useCallback(async () => {
    if (!sessionID) return null
    const next = await getHostStatus(sessionID)
    if (activeSessionIDRef.current === sessionID) setStatus(next)
    return next
  }, [sessionID])

  const load = useCallback(async () => {
    if (!sessionID) return
    const generation = ++loadGenerationRef.current
    setLoading(true)
    setErrorMessage('')
    setLogsReady(false)
    try {
      const [statusResult, logsResult] = await Promise.allSettled([getHostStatus(sessionID), listHostLogs(sessionID)])
      if (generation !== loadGenerationRef.current) return
      if (statusResult.status === 'rejected') throw statusResult.reason
      setStatus(statusResult.value)
      if (logsResult.status === 'fulfilled') {
        const chunks = logsResult.value.chunks ?? []
        setLogs(mergeLogChunks([], chunks))
        setLogsTruncated(logsResult.value.truncated)
        lastLogSeqRef.current = Math.max(logsResult.value.last_seq || 0, ...chunks.map((chunk) => chunk.seq), 0)
      } else {
        setLogs([])
        setLogsTruncated(false)
        setErrorMessage(`Logs unavailable: ${messageFromUnknown(logsResult.reason)}`)
      }
      setLogsReady(true)
    } catch (error) {
      if (generation === loadGenerationRef.current) setErrorMessage(messageFromUnknown(error))
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false)
    }
  }, [sessionID])

  useEffect(() => {
    setStatus(null)
    setLogs([])
    setLogsTruncated(false)
    setLogsReady(false)
    setServiceFilter('all')
    setFollowing(true)
    setStreamState('closed')
    lastLogSeqRef.current = 0
    if (sessionID) void load()
    return () => {
      loadGenerationRef.current += 1
    }
  }, [load, sessionID])

  useEffect(() => {
    const runtimeState = status?.runtime.status
    if (!sessionID || (runtimeState !== 'starting' && runtimeState !== 'stopping' && runtimeState !== 'running')) return

    const interval = window.setInterval(
      () => {
        void refreshStatus().catch(() => undefined)
      },
      runtimeState === 'running' ? 5_000 : 750,
    )
    return () => window.clearInterval(interval)
  }, [refreshStatus, sessionID, status?.runtime.status])

  useEffect(() => {
    if (!sessionID || !logsReady || typeof EventSource === 'undefined') return

    let disposed = false
    let source: EventSource | null = null
    let reconnectTimer: number | null = null
    let reconnectAttempt = 0

    const acceptData = (data: string) => {
      const payload = parseHostStreamPayload(data)
      if (!payload) return
      if (isHostLogChunk(payload)) appendLogs([payload])
      else setStatus(payload)
    }

    const connect = () => {
      if (disposed) return
      setStreamState(reconnectAttempt > 0 ? 'reconnecting' : 'connecting')
      source = new EventSource(hostLogStreamURL(sessionID, lastLogSeqRef.current))
      source.addEventListener('open', () => {
        reconnectAttempt = 0
        if (!disposed) setStreamState('open')
      })
      source.addEventListener('message', (event) => acceptData((event as MessageEvent<string>).data))
      source.addEventListener('log', (event) => acceptData((event as MessageEvent<string>).data))
      source.addEventListener('status', (event) => acceptData((event as MessageEvent<string>).data))
      source.addEventListener('error', () => {
        source?.close()
        source = null
        if (disposed) return
        reconnectAttempt += 1
        setStreamState('reconnecting')
        reconnectTimer = window.setTimeout(connect, Math.min(1_000 * 2 ** (reconnectAttempt - 1), 10_000))
      })
    }

    connect()
    return () => {
      disposed = true
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      source?.close()
    }
  }, [appendLogs, logsReady, sessionID])

  const visibleLogs = useMemo(
    () => (serviceFilter === 'all' ? logs : logs.filter((chunk) => chunk.service === serviceFilter)),
    [logs, serviceFilter],
  )

  useEffect(() => {
    if (!following) return
    const viewport = logViewportRef.current
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }, [following, visibleLogs])

  async function runAction(nextAction: HostAction) {
    if (!sessionID) return
    const actionFn = {
      validate: validateHost,
      start: startHost,
      stop: stopHost,
      restart: restartHost,
      check: checkHost,
    }[nextAction]
    setAction(nextAction)
    setErrorMessage('')
    try {
      const next = await actionFn(sessionID)
      if (activeSessionIDRef.current === sessionID) setStatus(next)
      if (nextAction === 'start' || nextAction === 'restart') setFollowing(true)
    } catch (error) {
      setErrorMessage(messageFromUnknown(error))
      try {
        await refreshStatus()
      } catch {
        // Preserve the action error when a follow-up status refresh also fails.
      }
    } finally {
      setAction(null)
    }
  }

  if (!session) {
    return <EmptyPreview resolving={Boolean(resolvingSessionID)} />
  }

  const config = status?.config
  const runtime = status?.runtime
  const archived = Boolean(session.archived_at)
  const active = runtime?.status === 'running' || runtime?.status === 'starting' || runtime?.status === 'stopping'
  const startDisabled = !config?.present || !config.valid || active || archived
  const restartDisabled = !config?.present || !config.valid || runtime?.status === 'stopping' || archived
  const stopDisabled = runtime?.status !== 'running' && runtime?.status !== 'starting'

  return (
    <div className="host-preview-body flex h-full min-h-0 flex-col overflow-y-auto px-3 pb-3">
      <div className="flex min-h-0 w-full flex-1 flex-col gap-3">
        <section className="shrink-0 rounded-lg border border-border/80 bg-background/72 p-4 shadow-sm" aria-labelledby="host-preview-heading">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Server className="size-5 text-primary" aria-hidden="true" />
                <h2 id="host-preview-heading" className="text-base font-semibold">Hosted preview</h2>
                {status ? <StateBadge state={status.runtime.status} /> : null}
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground" title={session.workspace_path}>
                {session.workspace_path}
              </p>
            </div>
            {runtime?.url && runtime.status === 'running' ? (
              <Button asChild size="sm">
                <a href={runtime.url} target="_blank" rel="noreferrer">
                  <ExternalLink aria-hidden="true" />
                  Open preview
                </a>
              </Button>
            ) : null}
          </div>

          {loading && !status ? (
            <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Loading preview status…
            </div>
          ) : null}

          {errorMessage ? (
            <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <span>{errorMessage}</span>
              {!status ? (
                <Button size="sm" variant="outline" onClick={() => void load()}>
                  <RefreshCw aria-hidden="true" />
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}

          {status ? (
            <>
              <ConfigNotice status={status} />
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <ActionButton action="validate" currentAction={action} variant="outline" onClick={runAction}>
                  <CheckCircle2 aria-hidden="true" />
                  Validate
                </ActionButton>
                <ActionButton action="start" currentAction={action} disabled={startDisabled} onClick={runAction}>
                  <Play aria-hidden="true" />
                  Start
                </ActionButton>
                <ActionButton action="stop" currentAction={action} disabled={stopDisabled} variant="destructive" onClick={runAction}>
                  <Square aria-hidden="true" />
                  Stop
                </ActionButton>
                <ActionButton action="restart" currentAction={action} disabled={restartDisabled} variant="outline" onClick={runAction}>
                  <RotateCw aria-hidden="true" />
                  Restart
                </ActionButton>
                <ActionButton action="check" currentAction={action} disabled={runtime?.status !== 'running'} variant="outline" onClick={runAction}>
                  <RefreshCw aria-hidden="true" />
                  Check
                </ActionButton>
              </div>
              {archived ? <p className="mt-2 text-xs text-muted-foreground">Restore this session before starting its preview.</p> : null}
            </>
          ) : null}
        </section>

        {status ? (
          <div className="grid shrink-0 gap-3 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <RuntimePanel status={status} />
            <ServicesPanel status={status} />
          </div>
        ) : null}

        {status ? (
          <section className="flex min-h-80 flex-1 flex-col overflow-hidden rounded-lg border border-border/80 bg-background/72 shadow-sm" aria-labelledby="host-logs-heading">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/70 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Terminal className="size-4 text-muted-foreground" aria-hidden="true" />
                <h3 id="host-logs-heading" className="text-sm font-semibold">Service logs</h3>
                <Badge variant={streamState === 'open' ? 'success' : streamState === 'reconnecting' ? 'warning' : 'outline'} className="min-h-5 px-1.5 py-0 text-[10px]">
                  {streamState === 'open' ? 'live' : streamState === 'reconnecting' ? 'reconnecting' : streamState}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor="host-log-service">Filter logs by service</label>
                <select
                  id="host-log-service"
                  value={serviceFilter}
                  onChange={(event) => setServiceFilter(event.target.value)}
                  className="h-8 max-w-40 rounded-md border border-border bg-background px-2 text-xs"
                >
                  <option value="all">All services</option>
                  {(status.services ?? []).map((service) => <option key={service.name} value={service.name}>{service.name}</option>)}
                </select>
                <Button size="sm" variant={following ? 'secondary' : 'outline'} aria-pressed={following} onClick={() => setFollowing((value) => !value)}>
                  {following ? 'Following' : 'Follow logs'}
                </Button>
              </div>
            </div>
            {logsTruncated ? (
              <p className="shrink-0 border-b border-[hsl(var(--warning)/0.24)] bg-[hsl(var(--warning)/0.08)] px-3 py-1.5 text-xs text-[hsl(var(--warning))]">
                Older output has rolled out of the retained log buffer.
              </p>
            ) : null}
            <div
              ref={logViewportRef}
              data-testid="host-log-viewport"
              className="min-h-0 flex-1 overflow-auto bg-background/72 p-3 font-mono text-[12px] leading-5 text-foreground"
              onScroll={(event) => {
                const element = event.currentTarget
                if (following && element.scrollHeight - element.scrollTop - element.clientHeight > 32) setFollowing(false)
              }}
            >
              {visibleLogs.length === 0 ? (
                <p className="font-sans text-xs text-muted-foreground">No retained output{serviceFilter === 'all' ? '' : ` for ${serviceFilter}`}.</p>
              ) : visibleLogs.map((chunk) => <LogChunk key={chunk.seq} chunk={chunk} />)}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}

function ConfigNotice({ status }: { status: HostStatus }) {
  const config = status.config
  if (!config.present) {
    return (
      <div className="mt-4 rounded-lg border border-dashed border-border bg-muted/40 p-3">
        <div className="flex items-start gap-2">
          <FileWarning className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium">No host recipe found</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Add <code className="rounded bg-muted px-1 py-0.5">{config.path || '.gorchestra/host.yaml'}</code> to this workspace, then validate it here.
            </p>
          </div>
        </div>
      </div>
    )
  }
  if (!config.valid) {
    return (
      <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-destructive">Host recipe is invalid</p>
            {(config.errors ?? []).length > 0 ? (
              <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-destructive">
                {(config.errors ?? []).map((error, index) => <li key={`${index}-${error}`}>{error}</li>)}
              </ul>
            ) : null}
          </div>
        </div>
      </div>
    )
  }
  if (config.stale) {
    return (
      <div className="mt-4 rounded-lg border border-[hsl(var(--warning)/0.32)] bg-[hsl(var(--warning)/0.10)] p-3 text-sm">
        <p className="font-medium text-[hsl(var(--warning))]">Recipe changed while this preview was running</p>
        <p className="mt-1 text-xs text-muted-foreground">Restart the preview to load the latest configuration.</p>
      </div>
    )
  }
  return (
    <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
      <CheckCircle2 className="size-4 text-[hsl(var(--success))]" aria-hidden="true" />
      <span><code>{config.path}</code> is valid{config.name ? ` · ${config.name}` : ''}.</span>
    </div>
  )
}

function RuntimePanel({ status }: { status: HostStatus }) {
  const runtime = status.runtime
  return (
    <section className="rounded-lg border border-border/80 bg-background/72 p-4 shadow-sm" aria-labelledby="host-runtime-heading">
      <div className="flex items-center justify-between gap-2">
        <h3 id="host-runtime-heading" className="text-sm font-semibold">Runtime</h3>
        <StateBadge state={runtime.status} />
      </div>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
        <dt className="text-muted-foreground">URL</dt>
        <dd className="truncate font-mono" title={runtime.url}>{runtime.url || 'Not published'}</dd>
        <dt className="text-muted-foreground">Started</dt>
        <dd>{formatTimestamp(runtime.started_at)}</dd>
        <dt className="text-muted-foreground">Stopped</dt>
        <dd>{formatTimestamp(runtime.stopped_at)}</dd>
      </dl>
      {runtime.error ? <p role="alert" className="mt-3 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{runtime.error}</p> : null}
    </section>
  )
}

function ServicesPanel({ status }: { status: HostStatus }) {
  return (
    <section className="rounded-lg border border-border/80 bg-background/72 p-4 shadow-sm" aria-labelledby="host-services-heading">
      <div className="flex items-center justify-between gap-2">
        <h3 id="host-services-heading" className="text-sm font-semibold">Services</h3>
        <span className="text-xs text-muted-foreground">{(status.services ?? []).length}</span>
      </div>
      {(status.services ?? []).length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">No services have been loaded.</p>
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {(status.services ?? []).map((service) => (
            <article key={service.name} className="rounded-lg border border-border/70 bg-background/50 p-3">
              <div className="flex items-center justify-between gap-2">
                <strong className="truncate text-sm">{service.name}</strong>
                <ServiceStateBadge state={service.status} />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
                <span>{service.port ? `127.0.0.1:${service.port}` : 'no port'}</span>
                {(service.route_paths ?? []).map((path) => <span key={path}>{path}</span>)}
                {service.exit_code !== undefined && service.exit_code !== null ? <span>exit {service.exit_code}</span> : null}
              </div>
              {service.error ? <p className="mt-2 text-xs text-destructive">{service.error}</p> : null}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function ActionButton({
  action,
  currentAction,
  children,
  onClick,
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'onClick'> & {
  action: HostAction
  currentAction: HostAction | null
  onClick: (action: HostAction) => void
}) {
  const pending = currentAction === action
  return (
    <Button
      size="sm"
      {...props}
      aria-label={props['aria-label'] ?? action[0].toUpperCase() + action.slice(1)}
      disabled={Boolean(currentAction) || props.disabled}
      onClick={() => onClick(action)}
    >
      {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : children}
    </Button>
  )
}

function StateBadge({ state }: { state: HostRuntimeState }) {
  return <Badge variant={badgeVariant(state)} className="capitalize">{state}</Badge>
}

function ServiceStateBadge({ state }: { state: HostServiceState }) {
  return <Badge variant={badgeVariant(state)} className="min-h-5 px-1.5 py-0 text-[10px] capitalize">{state}</Badge>
}

function badgeVariant(state: HostRuntimeState | HostServiceState): BadgeProps['variant'] {
  if (state === 'running') return 'success'
  if (state === 'starting' || state === 'stopping') return 'warning'
  if (state === 'failed') return 'destructive'
  return 'outline'
}

function LogChunk({ chunk }: { chunk: HostLogChunk }) {
  return (
    <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-x-2" data-seq={chunk.seq}>
      <span className="select-none text-muted-foreground">{chunk.seq}</span>
      <span className="select-none text-primary">[{chunk.service}]</span>
      <pre className={cn('min-w-0 whitespace-pre-wrap break-words font-inherit', chunk.stream === 'stderr' && 'text-destructive')}>{chunk.data}</pre>
    </div>
  )
}

function EmptyPreview({ resolving }: { resolving: boolean }) {
  return (
    <div className="flex h-full w-full min-h-0 items-center justify-center p-8 text-center">
      {resolving ? (
        <div>
          <Loader2 className="mx-auto mb-3 size-6 animate-spin text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-medium">Loading session…</p>
          <p className="mt-1 text-xs text-muted-foreground">Restoring the selected preview from the route.</p>
        </div>
      ) : (
        <div>
          <Server className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-medium">Select a session to manage a hosted preview.</p>
        </div>
      )}
    </div>
  )
}

function mergeLogChunks(current: HostLogChunk[], incoming: HostLogChunk[]) {
  const bySeq = new Map(current.map((chunk) => [chunk.seq, chunk]))
  for (const chunk of incoming) bySeq.set(chunk.seq, chunk)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-maxRenderedChunks)
}

function parseHostStreamPayload(data: string): HostLogChunk | HostStatus | null {
  try {
    const value: unknown = JSON.parse(data)
    if (isHostLogChunk(value) || isHostStatus(value)) return value
  } catch {
    // Ignore malformed or heartbeat stream records.
  }
  return null
}

function isHostLogChunk(value: unknown): value is HostLogChunk {
  if (!value || typeof value !== 'object') return false
  const chunk = value as Partial<HostLogChunk>
  return typeof chunk.seq === 'number' && typeof chunk.service === 'string' && typeof chunk.data === 'string'
}

function isHostStatus(value: unknown): value is HostStatus {
  if (!value || typeof value !== 'object') return false
  const status = value as Partial<HostStatus>
  return typeof status.session_id === 'string' && Boolean(status.config) && Boolean(status.runtime) && Array.isArray(status.services)
}

function formatTimestamp(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString()
}

function messageFromUnknown(error: unknown) {
  return error instanceof Error && error.message ? error.message : 'Preview request failed'
}
