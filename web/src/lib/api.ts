export type SessionStatus = 'idle' | 'running' | 'failed'
export type AgentType = 'fake' | 'codex' | 'claude' | 'opencode' | 'pi'

export type Session = {
  id: string
  title: string
  agent_type: AgentType
  status: SessionStatus
  provider_session_id?: string
  workspace_path: string
  agent_options?: SessionAgentOptions
  event_count: number
  last_event_seq?: number
  tool_count: number
  notification_attention_seq?: number
  pending_input?: boolean
  pending_permission_count?: number
  created_at: string
  updated_at: string
  completed_at: string | null
  archived_at: string | null
}

export type SessionAgentOptions = {
  codex?: {
    run_dangerously?: boolean
    permission_policy?: PermissionPolicy
  }
  claude?: {
    run_dangerously?: boolean
    permission_policy?: PermissionPolicy
  }
  opencode?: { permission_policy?: PermissionPolicy }
}

export type PermissionPolicy = 'ask' | 'deny' | 'bypass'

export type PermissionOption = {
  id: string
  label: string
  description?: string
  decision: 'allow' | 'deny' | 'cancel'
  scope?: 'once' | 'session'
}

export type PermissionRequest = {
  request_id: string
  provider: string
  provider_event_type: string
  kind: string
  title: string
  description?: string
  reason?: string
  command?: string
  cwd?: string
  tool_name?: string
  tool_input?: unknown
  paths?: string[]
  diff?: string
  requested_grants?: unknown
  options: PermissionOption[]
}

export type AgentEvent = {
  id: string
  session_id: string
  seq: number
  type: string
  role: string
  status: string
  payload: unknown
  created_at: string
  transient?: boolean
}

export type CodexReasoningEffortOption = {
  reasoning_effort: string
  description: string
}

export type CodexServiceTierOption = {
  id: string
  name: string
  description: string
}

export type CodexModelOption = {
  id: string
  model: string
  display_name: string
  description: string
  hidden: boolean
  supported_reasoning_efforts: CodexReasoningEffortOption[]
  default_reasoning_effort: string
  service_tiers: CodexServiceTierOption[]
  default_service_tier: string
  is_default: boolean
}

export type CodexCollaborationModeOption = {
  name: string
  mode: string
  model?: string
  reasoning_effort?: string
}

export type CodexAgentOptions = {
  default_model: string
  models: CodexModelOption[]
  collaboration_modes: CodexCollaborationModeOption[]
}

export type OpenCodeAgentOptions = CodexAgentOptions
export type PiAgentOptions = CodexAgentOptions

export type CodexSubmitOptions = {
  model?: string
  reasoning_effort?: string
  fast_mode?: boolean
  planning_mode?: boolean
  service_tier?: string
}

export type ClaudeSubmitOptions = {
  model?: string
  effort?: string
  planning_mode?: boolean
}

export type OpenCodeSubmitOptions = {
  model?: string
  planning_mode?: boolean
}

export type PiSubmitOptions = {
  model?: string
  thinking_level?: string
}

export type SubmitAgentOptions = {
  codex?: CodexSubmitOptions
  claude?: ClaudeSubmitOptions
  opencode?: OpenCodeSubmitOptions
  pi?: PiSubmitOptions
}

export type QueuedMessage = {
  id: string
  session_id: string
  seq: number
  content: string
  agent_options?: SubmitAgentOptions
  created_at: string
}

export type MessageAttachment = {
  name: string
  media_type: string
  data_url: string
  size_bytes: number
}

export type UserInputOption = {
  label: string
  description: string
}

export type UserInputQuestion = {
  id: string
  header: string
  question: string
  is_other: boolean
  is_secret: boolean
  options: UserInputOption[]
}

export type UserInputQuestionAnswer = {
  answers: string[]
}

export type UserInputAnswers = Record<string, UserInputQuestionAnswer>

export type WorkspaceRoot = {
  id: string
  name: string
  path: string
  default: boolean
}

export type WorkspaceEntryType = 'directory' | 'file'

export type WorkspaceEntry = {
  name: string
  path: string
  type: WorkspaceEntryType
  size_bytes: number
  modified_at: string
  git_status?: string
}

export type WorkspaceSearchResult = WorkspaceEntry & {
  match_type?: 'name' | 'content'
  line_number?: number
  line_text?: string
}

export type WorkspaceGitSummary = {
  branch?: string
  added: number
  modified: number
  deleted: number
}

export type WorkspaceBrowseResponse = {
  root_id?: string
  root_path: string
  path: string
  entries: WorkspaceEntry[]
  git_summary?: WorkspaceGitSummary
}

export type WorkspaceFileContent = {
  name: string
  path: string
  size_bytes: number
  modified_at: string
  content: string
  encoding: 'utf-8' | 'binary'
  truncated: boolean
  git_status?: string
}

export type WorkspaceSearchResponse = {
  query: string
  path: string
  results: WorkspaceSearchResult[]
}

export type WorkspaceFileUploadResponse = {
  files: WorkspaceEntry[]
}

export type ConsoleStatus = {
  session_id: string
  workspace_path: string
  running: boolean
  attached_count: number
  started_at?: string
  idle_since?: string | null
  exited_at?: string | null
  exit_code?: number | null
}

export type PushSubscriptionPayload = {
  endpoint?: string | null
  keys?: {
    p256dh?: string
    auth?: string
  }
}

export type NotificationDebugSubscription = {
  endpoint_hash: string
  origin: string
  user_agent: string
  last_error?: string
  created_at: string
  updated_at: string
  disabled_at?: string
}

export type NotificationDebugAttempt = {
  id: number
  endpoint_hash: string
  origin: string
  payload_kind: string
  session_id?: string
  event_type?: string
  http_status?: number
  response_status?: string
  error?: string
  created_at: string
}

export type NotificationClientDiagnostic = {
  created_at: string
  received_at: string
  user_agent?: string
  payload_web_push?: unknown
  declarative: boolean
  badge?: {
    supported?: boolean
    attempted?: boolean
    ok?: boolean
    count?: number
    error?: string
  }
  attention_count?: number
  show_notification?: {
    attempted?: boolean
    ok?: boolean
    reason?: string
    error?: string
  }
  session_id?: string
  seq?: number
}

type ErrorResponse = {
  error?: string
}

type ListSessionsResponse = {
  sessions: Session[]
}

type WorkspaceRootsResponse = {
  roots: WorkspaceRoot[]
}

type CreateSessionResponse = {
  session_id: string
}

export type SubmitMessageResponse = {
  session_id: string
  status: SessionStatus
  accepted_as?: 'run' | 'queued'
  queued_message?: QueuedMessage
}

type SessionActionResponse = {
  session_id: string
  status: SessionStatus
}

type CancelSessionResponse = {
  session_id: string
  status: SessionStatus | 'cancelling'
}

type AnswerUserInputResponse = {
  session_id: string
  request_id: string
  status: 'answered'
}

type EventHistoryResponse = {
  events: AgentEvent[]
}

type NotificationPublicKeyResponse = {
  public_key: string
  supported: boolean
}

type NotificationStateResponse = {
  enabled: boolean
}

type NotificationTestResponse = {
  sent: boolean
}

export type NotificationDebugResponse = {
  public_key_fingerprint: string
  subscriptions: NotificationDebugSubscription[]
  recent_attempts: NotificationDebugAttempt[]
  client_diagnostics?: NotificationClientDiagnostic[]
}

type ListSessionsOptions = {
  limit?: number
  status?: SessionStatus
  include_archived?: boolean
}

export const defaultEventWindowLimit = 500
export const defaultEventTurnPageSize = 2

export class APIError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'APIError'
    this.status = status
  }
}

export function isAgentType(value: string): value is AgentType {
  return value === 'fake' || value === 'codex' || value === 'claude' || value === 'opencode' || value === 'pi'
}

export async function fetchHealth() {
  await requestJSON<{ status: string }>('/api/health')
}

export async function listSessions(options: ListSessionsOptions | number = {}) {
  const limit = typeof options === 'number' ? options : (options.limit ?? 50)
  const status = typeof options === 'number' ? undefined : options.status
  const includeArchived = typeof options === 'number' ? false : (options.include_archived ?? false)
  const params = new URLSearchParams({ limit: String(limit) })
  if (status) {
    params.set('status', status)
  }
  if (includeArchived) {
    params.set('include_archived', 'true')
  }

  const data = await requestJSON<ListSessionsResponse>(`/api/sessions?${params.toString()}`)
  return data.sessions
}

export async function getSession(sessionID: string) {
  return requestJSON<Session>(`/api/sessions/${encodeURIComponent(sessionID)}`)
}

export async function clearSessionNotificationAttention(sessionID: string) {
  return requestJSON<Session>(`/api/sessions/${encodeURIComponent(sessionID)}/notification-attention/clear`, {
    method: 'POST',
  })
}

export async function createSession(params: {
  agent_type: AgentType
  title?: string
  workspace_path?: string
  agent_options?: SessionAgentOptions
}) {
  const data = await requestJSON<CreateSessionResponse>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(params),
  })
  return getSession(data.session_id)
}

export async function updateSessionTitle(sessionID: string, title: string) {
  return requestJSON<Session>(`/api/sessions/${encodeURIComponent(sessionID)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })
}

export async function updateSessionWorkspace(sessionID: string, workspacePath: string) {
  return requestJSON<Session>(`/api/sessions/${encodeURIComponent(sessionID)}`, {
    method: 'PATCH',
    body: JSON.stringify({ workspace_path: workspacePath }),
  })
}

export async function updateSessionAgentOptions(sessionID: string, agentOptions: SessionAgentOptions) {
  return requestJSON<Session>(`/api/sessions/${encodeURIComponent(sessionID)}`, {
    method: 'PATCH',
    body: JSON.stringify({ agent_options: agentOptions }),
  })
}

export async function archiveSession(sessionID: string) {
  return requestJSON<Session>(`/api/sessions/${encodeURIComponent(sessionID)}/archive`, {
    method: 'POST',
  })
}

export async function restoreSession(sessionID: string) {
  return requestJSON<Session>(`/api/sessions/${encodeURIComponent(sessionID)}/restore`, {
    method: 'POST',
  })
}

export async function clearSession(sessionID: string) {
  return requestJSON<SessionActionResponse>(`/api/sessions/${encodeURIComponent(sessionID)}/clear`, {
    method: 'POST',
  })
}

export async function compactSession(sessionID: string) {
  return requestJSON<SessionActionResponse>(`/api/sessions/${encodeURIComponent(sessionID)}/compact`, {
    method: 'POST',
  })
}

export async function fetchAgentOptions(agentType: AgentType) {
  if (agentType !== 'codex' && agentType !== 'opencode' && agentType !== 'pi') {
    throw new Error(`No options API for ${agentType}`)
  }
  return requestJSON<CodexAgentOptions | OpenCodeAgentOptions | PiAgentOptions>(
    `/api/agents/${encodeURIComponent(agentType)}/options`,
  )
}

export async function listWorkspaceRoots() {
  const data = await requestJSON<WorkspaceRootsResponse>('/api/workspaces/roots')
  return data.roots
}

export async function browseWorkspace(rootID: string, path = '') {
  const params = new URLSearchParams()
  if (rootID) params.set('root_id', rootID)
  if (path) params.set('path', path)
  return requestJSON<WorkspaceBrowseResponse>(withQuery('/api/workspaces/browse', params))
}

export async function listSessionFiles(sessionID: string, path = '') {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  return requestJSON<WorkspaceBrowseResponse>(withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/files`, params))
}

export async function uploadSessionFiles(sessionID: string, files: File[], path = '') {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  const body = new FormData()
  files.forEach((file) => body.append('files', file, file.name))
  return requestJSON<WorkspaceFileUploadResponse>(
    withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/files/upload`, params),
    { method: 'POST', body },
  )
}

export async function searchSessionFiles(sessionID: string, query: string, path = '') {
  const params = new URLSearchParams({ q: query })
  if (path) params.set('path', path)
  return requestJSON<WorkspaceSearchResponse>(
    withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/files/search`, params),
  )
}

export async function getSessionFileContent(sessionID: string, path: string) {
  const params = new URLSearchParams({ path })
  return requestJSON<WorkspaceFileContent>(
    withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/files/content`, params),
  )
}

export async function updateSessionFileContent(sessionID: string, path: string, content: string) {
  const params = new URLSearchParams({ path })
  return requestJSON<WorkspaceFileContent>(
    withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/files/content`, params),
    {
      method: 'PUT',
      body: JSON.stringify({ content }),
    },
  )
}

export async function submitMessage(
  sessionID: string,
  content: string,
  agentOptions?: SubmitAgentOptions,
  attachments: MessageAttachment[] = [],
  queue = false,
) {
  const body: {
    content: string
    agent_options?: SubmitAgentOptions
    attachments?: MessageAttachment[]
    queue?: boolean
  } = { content }
  if (agentOptions) {
    body.agent_options = agentOptions
  }
  if (attachments.length > 0) {
    body.attachments = attachments
  }
  if (queue) {
    body.queue = true
  }

  return requestJSON<SubmitMessageResponse>(`/api/sessions/${encodeURIComponent(sessionID)}/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function fetchQueuedMessages(sessionID: string) {
  return requestJSON<{ messages: QueuedMessage[] }>(`/api/sessions/${encodeURIComponent(sessionID)}/queued-messages`)
}

export async function removeQueuedMessage(sessionID: string, queuedMessageID: string) {
  return requestJSON<QueuedMessage>(
    `/api/sessions/${encodeURIComponent(sessionID)}/queued-messages/${encodeURIComponent(queuedMessageID)}`,
    {
      method: 'DELETE',
    },
  )
}

export async function cancelSession(sessionID: string) {
  return requestJSON<CancelSessionResponse>(`/api/sessions/${encodeURIComponent(sessionID)}/cancel`, {
    method: 'POST',
  })
}

export async function answerUserInput(sessionID: string, requestID: string, answers: UserInputAnswers) {
  return requestJSON<AnswerUserInputResponse>(
    `/api/sessions/${encodeURIComponent(sessionID)}/requests/${encodeURIComponent(requestID)}/answer`,
    {
      method: 'POST',
      body: JSON.stringify({ answers }),
    },
  )
}

export async function resolvePermission(sessionID: string, requestID: string, optionID: string) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 15_000)
  try {
    return await requestJSON<{ session_id: string; request_id: string; status: string }>(
      `/api/sessions/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(requestID)}/resolve`,
      { method: 'POST', body: JSON.stringify({ option_id: optionID }), signal: controller.signal },
    )
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('The permission response timed out. Try again or stop the run.', { cause: error })
    }
    throw error
  } finally {
    window.clearTimeout(timeout)
  }
}

type EventListOptions = {
  includeDebug?: boolean
}

function eventListParams(params: Record<string, string>, options: EventListOptions) {
  const search = new URLSearchParams(params)
  if (options.includeDebug) {
    search.set('include_debug', 'true')
  }
  return search
}

export async function listEvents(sessionID: string, afterSeq = 0, limit = 1000, options: EventListOptions = {}) {
  const params = eventListParams({ after_seq: String(afterSeq), limit: String(limit) }, options)
  const data = await requestJSON<EventHistoryResponse>(
    withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/events`, params),
  )
  return data.events
}

export async function listRecentEvents(
  sessionID: string,
  limit = defaultEventWindowLimit,
  options: EventListOptions = {},
) {
  const params = eventListParams({ tail: 'true', limit: String(limit) }, options)
  const data = await requestJSON<EventHistoryResponse>(
    withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/events`, params),
  )
  return data.events
}

export async function listEventsBefore(
  sessionID: string,
  beforeSeq: number,
  limit = defaultEventWindowLimit,
  options: EventListOptions = {},
) {
  const params = eventListParams({ before_seq: String(beforeSeq), limit: String(limit) }, options)
  const data = await requestJSON<EventHistoryResponse>(
    withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/events`, params),
  )
  return data.events
}

export async function listRecentEventTurns(
  sessionID: string,
  turns = defaultEventTurnPageSize,
  options: EventListOptions = {},
) {
  const params = eventListParams({ tail: 'true', turns: String(turns) }, options)
  const data = await requestJSON<EventHistoryResponse>(
    withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/events`, params),
  )
  return data.events
}

export async function listEventTurnsBefore(
  sessionID: string,
  beforeSeq: number,
  turns = defaultEventTurnPageSize,
  options: EventListOptions = {},
) {
  const params = eventListParams({ before_seq: String(beforeSeq), turns: String(turns) }, options)
  const data = await requestJSON<EventHistoryResponse>(
    withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/events`, params),
  )
  return data.events
}

export function eventStreamURL(sessionID: string, afterSeq: number, options: EventListOptions = {}) {
  const params = eventListParams({ after_seq: String(afterSeq) }, options)
  return withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/events/stream`, params)
}

export function sessionActivityStreamURL() {
  return '/api/sessions/activity/stream'
}

export async function fetchNotificationPublicKey() {
  return requestJSON<NotificationPublicKeyResponse>('/api/notifications/public-key')
}

export async function savePushSubscription(subscription: PushSubscriptionPayload) {
  return requestJSON<NotificationStateResponse>('/api/notifications/subscriptions', {
    method: 'POST',
    body: JSON.stringify(subscription),
  })
}

export async function deletePushSubscription(endpoint: string) {
  return requestJSON<NotificationStateResponse>('/api/notifications/subscriptions', {
    method: 'DELETE',
    body: JSON.stringify({ endpoint }),
  })
}

export async function sendTestNotification() {
  return requestJSON<NotificationTestResponse>('/api/notifications/test', {
    method: 'POST',
  })
}

export async function fetchNotificationDebug() {
  return requestJSON<NotificationDebugResponse>('/api/notifications/debug')
}

export async function getConsoleStatus(sessionID: string) {
  return requestJSON<ConsoleStatus>(`/api/sessions/${encodeURIComponent(sessionID)}/console`)
}

export async function startConsole(sessionID: string) {
  return requestJSON<ConsoleStatus>(`/api/sessions/${encodeURIComponent(sessionID)}/console`, {
    method: 'POST',
  })
}

export async function killConsole(sessionID: string) {
  await requestNoContent(`/api/sessions/${encodeURIComponent(sessionID)}/console`, {
    method: 'DELETE',
  })
}

export function consoleWebSocketURL(sessionID: string) {
  const httpURL = new URL(`/api/sessions/${encodeURIComponent(sessionID)}/console/ws`, window.location.href)
  httpURL.protocol = httpURL.protocol === 'https:' ? 'wss:' : 'ws:'
  return httpURL.toString()
}

function withQuery(path: string, params: URLSearchParams) {
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

async function requestJSON<T>(url: string, init: RequestInit = {}) {
  const multipart = typeof FormData !== 'undefined' && init.body instanceof FormData
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body && !multipart ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const payload = (await response.json()) as ErrorResponse
      if (payload.error) {
        message = payload.error
      }
    } catch {
      // Keep the HTTP status fallback when the body is not JSON.
    }
    throw new APIError(response.status, message)
  }

  return (await response.json()) as T
}

async function requestNoContent(url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...init.headers,
    },
  })

  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const payload = (await response.json()) as ErrorResponse
      if (payload.error) {
        message = payload.error
      }
    } catch {
      // Keep the HTTP status fallback when the body is not JSON.
    }
    throw new APIError(response.status, message)
  }
}
