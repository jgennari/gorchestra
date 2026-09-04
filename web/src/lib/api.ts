export type SessionStatus = 'idle' | 'running' | 'failed'
export type AgentType = 'fake' | 'codex' | 'claude' | 'opencode' | 'pi'

export type ScheduleCadence =
  | { kind: 'interval'; every: number; unit: 'minutes' | 'hours' | 'days' }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string; weekdays: string[] }
  | { kind: 'cron'; expression: string }

export type SessionSchedule = {
  id: string
  session_id: string
  name: string
  prompt: string
  cadence: ScheduleCadence
  timezone: string
  enabled: boolean
  next_run_at: string | null
  pending_count: number
  last_status?: string
  last_scheduled_for?: string | null
  created_at: string
  updated_at: string
}

export type ScheduleOccurrence = {
  id: string
  schedule_id: string
  trigger: 'scheduled' | 'manual'
  scheduled_for: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  run_id?: string
  error?: string
  created_at: string
  started_at?: string
  completed_at?: string
}

export type ScheduleInput = {
  name: string
  prompt: string
  cadence: ScheduleCadence
  timezone: string
  enabled: boolean
}

export type RepositorySkillBridge = {
  status: 'linked' | 'missing' | 'conflict' | 'error'
  path: string
  message?: string
}

export type RepositorySkill = {
  directory_name: string
  name: string
  description: string
  path: string
  modified_at?: string
  revision?: string
  validation_errors: string[]
  resource_count: number
  editable: boolean
  linked: boolean
  instructions?: string
  claude_bridge: RepositorySkillBridge
}

export type RepositorySkillInput = {
  name: string
  description: string
  instructions: string
  revision?: string
}

export type RepositorySkillBridgeRepair = {
  skill: RepositorySkill
  backup_path?: string
}

export type UserSkillCatalog = {
  home_path: string
  skills: RepositorySkill[]
}

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
  token_count?: number
  notification_attention_seq?: number
  pending_input?: boolean
  pending_permission_count?: number
  created_at: string
  updated_at: string
  completed_at: string | null
  archived_at: string | null
}

export type SpotlightSearchResultKind =
  'session' | 'user_message' | 'agent_message' | 'tool_call' | 'agent_instruction' | 'file'

export type SpotlightSearchResult = {
  id: string
  kind: SpotlightSearchResultKind
  scope: 'global' | 'local'
  title: string
  snippet?: string
  session_id: string
  session_title: string
  workspace_path?: string
  event_seq?: number
  path?: string
  line_number?: number
  created_at?: string
  archived?: boolean
}

export type SpotlightSearchResponse = {
  query: string
  results: SpotlightSearchResult[]
  local_error?: string
}

export type DashboardRange = '7d' | '30d' | '90d' | 'all'
export type DashboardRunStatus = 'completed' | 'failed' | 'cancelled' | 'running' | 'unknown'
export type DashboardRunKind = 'message' | 'compact' | 'unknown'
export type DashboardOutcomeKind = 'commit' | 'pull_request' | 'test' | 'delegation'

export type DashboardSummary = {
  runs: number
  completed_runs: number
  failed_runs: number
  cancelled_runs: number
  running_runs: number
  unknown_runs: number
  active_now: number
  success_rate: number | null
  agent_runtime_ms: number
  tool_calls: number
  files_changed: number
  input_requests: number
  permission_requests: number
  workspaces: number
  agents: number
}

export type DashboardActivityBucket = {
  start: string
  end: string
  completed: number
  failed: number
  cancelled: number
  running: number
  unknown: number
}

export type DashboardBreakdown = {
  key: string
  label: string
  runs: number
  completed_runs: number
  failed_runs: number
  cancelled_runs: number
  running_runs: number
  success_rate: number | null
  agent_runtime_ms: number
}

export type DashboardOutcome = {
  kind: DashboardOutcomeKind
  count: number
  passed: number
  failed: number
  reported: boolean
}

export type DashboardData = {
  generated_at: string
  range: DashboardRange
  range_start: string
  range_end: string
  time_zone: string
  bucket: 'day' | 'week' | 'month'
  summary: DashboardSummary
  activity: DashboardActivityBucket[]
  workspaces: DashboardBreakdown[]
  agents: DashboardBreakdown[]
  usage: {
    tokens: number
    token_runs: number
    cost_runs: number
    eligible_runs: number
    costs: Array<{ amount: number; currency: string; runs: number }>
  }
  outcomes: DashboardOutcome[]
}

export type DashboardRunOutcomeCounts = {
  commits: number
  pull_requests: number
  tests: number
  tests_passed: number
  tests_failed: number
  delegations: number
}

export type DashboardRun = {
  id: string
  session_id: string
  session_title: string
  kind: DashboardRunKind
  agent_type: string
  workspace_path: string
  status: DashboardRunStatus
  start_seq: number
  terminal_seq?: number
  started_at: string
  completed_at?: string
  duration_ms: number
  summary: string
  error: string
  tool_count: number
  file_count: number
  input_request_count: number
  permission_request_count: number
  token_count: number
  has_token_usage: boolean
  cost_amount: number
  cost_currency: string
  has_cost_usage: boolean
  archived: boolean
  outcomes: DashboardRunOutcomeCounts
}

export type DashboardRunPage = {
  runs: DashboardRun[]
  next_cursor?: string
  total: number
}

export type DashboardRunFilters = {
  status?: DashboardRunStatus
  kind?: DashboardRunKind | 'all'
  agent?: string
  workspace?: string
  outcome?: DashboardOutcomeKind
  sort?: 'recent' | 'duration'
  bucket_start?: string
  bucket_end?: string
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

export type SkillReference = {
  name: string
  path: string
}

export type SkillScope = 'repo' | 'user' | 'admin' | 'system'

export type AgentSkill = SkillReference & {
  description: string
  display_name?: string
  short_description?: string
  brand_color?: string
  scope: SkillScope
  enabled: boolean
}

export type AgentSkillError = {
  path: string
  message: string
}

export type AgentSkillCatalog = {
  skills: AgentSkill[]
  errors: AgentSkillError[]
  revision?: string
}

export type QueuedMessage = {
  id: string
  session_id: string
  seq: number
  content: string
  agent_options?: SubmitAgentOptions
  skills?: SkillReference[]
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
  media_type: string
  preview_kind: 'image' | 'audio' | 'video' | 'pdf' | 'none'
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

export type HostRuntimeState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'
export type HostServiceState = 'stopped' | 'starting' | 'running' | 'failed'

export type HostConfigStatus = {
  path: string
  present: boolean
  valid: boolean
  stale: boolean
  digest?: string
  loaded_digest?: string
  name?: string
  errors: string[]
}

export type HostRuntimeStatus = {
  status: HostRuntimeState
  url?: string
  started_at?: string
  stopped_at?: string
  error?: string
}

export type HostServiceStatus = {
  name: string
  status: HostServiceState
  port?: number
  route_paths: string[]
  started_at?: string
  stopped_at?: string
  exit_code?: number | null
  error?: string
}

export type HostStatus = {
  session_id: string
  config: HostConfigStatus
  runtime: HostRuntimeStatus
  services: HostServiceStatus[]
  log_cursor: number
}

export type HostLogStream = 'stdout' | 'stderr'

export type HostLogChunk = {
  seq: number
  service: string
  stream: HostLogStream
  data: string
  created_at: string
}

export type HostLogsResponse = {
  chunks: HostLogChunk[]
  first_seq: number
  last_seq: number
  truncated: boolean
}

export type HostLogOptions = {
  afterSeq?: number
  limit?: number
  service?: string
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

export type EventHistoryPage = {
  first_seq: number
  last_seq: number
  server_last_seq?: number
  has_older: boolean
  has_newer: boolean
  starts_mid_turn: boolean
  ends_mid_turn: boolean
}

export type EventHistoryResponse = {
  events: AgentEvent[]
  page?: EventHistoryPage
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

export async function getDashboard(range: DashboardRange = '30d', signal?: AbortSignal) {
  const params = new URLSearchParams({
    range,
    time_zone: dashboardTimeZone(),
  })
  return requestJSON<DashboardData>(`/api/dashboard?${params.toString()}`, { signal })
}

export async function listDashboardRuns(
  range: DashboardRange = '30d',
  filters: DashboardRunFilters = {},
  cursor = '',
  limit = 25,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({
    range,
    time_zone: dashboardTimeZone(),
    limit: String(limit),
  })
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value)
  }
  if (cursor) params.set('cursor', cursor)
  return requestJSON<DashboardRunPage>(`/api/dashboard/runs?${params.toString()}`, { signal })
}

export async function getSession(sessionID: string) {
  return requestJSON<Session>(`/api/sessions/${encodeURIComponent(sessionID)}`)
}

export async function searchSpotlight(query: string, sessionID?: string | null, signal?: AbortSignal) {
  const params = new URLSearchParams({ q: query })
  if (sessionID) params.set('session_id', sessionID)
  return requestJSON<SpotlightSearchResponse>(withQuery('/api/search', params), { signal })
}

function dashboardTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export async function clearSessionNotificationAttention(sessionID: string) {
  return requestJSON<Session>(`/api/sessions/${encodeURIComponent(sessionID)}/notification-attention/clear`, {
    method: 'POST',
  })
}

export async function clearAllSessionNotificationAttention() {
  return requestJSON<{ cleared: boolean }>('/api/sessions/notification-attention/clear', {
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

export async function fetchSessionSkills(sessionID: string, refresh = false) {
  const params = new URLSearchParams()
  if (refresh) params.set('refresh', 'true')
  return requestJSON<AgentSkillCatalog>(withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/skills`, params))
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

export function sessionFileRawURL(
  sessionID: string,
  path: string,
  options: { download?: boolean; raw?: boolean } = {},
) {
  const params = new URLSearchParams({ path })
  if (options.download) params.set('download', '1')
  if (options.raw) params.set('raw', '1')
  return withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/files/raw`, params)
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
  skills: SkillReference[] = [],
  clientSubmissionID = '',
) {
  const body: {
    content: string
    agent_options?: SubmitAgentOptions
    attachments?: MessageAttachment[]
    queue?: boolean
    skills?: SkillReference[]
    client_submission_id?: string
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
  if (skills.length > 0) {
    body.skills = skills
  }
  if (clientSubmissionID) {
    body.client_submission_id = clientSubmissionID
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

export async function listSchedules(sessionID: string) {
  const response = await requestJSON<{ schedules: SessionSchedule[] }>(
    `/api/sessions/${encodeURIComponent(sessionID)}/schedules`,
  )
  return response.schedules
}

export async function createSchedule(sessionID: string, input: ScheduleInput) {
  return requestJSON<SessionSchedule>(`/api/sessions/${encodeURIComponent(sessionID)}/schedules`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function updateSchedule(sessionID: string, scheduleID: string, input: ScheduleInput) {
  return requestJSON<SessionSchedule>(
    `/api/sessions/${encodeURIComponent(sessionID)}/schedules/${encodeURIComponent(scheduleID)}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  )
}

export async function deleteSchedule(sessionID: string, scheduleID: string) {
  return requestNoContent(
    `/api/sessions/${encodeURIComponent(sessionID)}/schedules/${encodeURIComponent(scheduleID)}`,
    { method: 'DELETE' },
  )
}

export async function runScheduleNow(sessionID: string, scheduleID: string) {
  return requestJSON<ScheduleOccurrence>(
    `/api/sessions/${encodeURIComponent(sessionID)}/schedules/${encodeURIComponent(scheduleID)}/run-now`,
    { method: 'POST' },
  )
}

export async function listScheduleOccurrences(sessionID: string, scheduleID: string, limit = 25) {
  const response = await requestJSON<{ occurrences: ScheduleOccurrence[] }>(
    `/api/sessions/${encodeURIComponent(sessionID)}/schedules/${encodeURIComponent(scheduleID)}/occurrences?limit=${limit}`,
  )
  return response.occurrences
}

export async function cancelScheduleOccurrence(sessionID: string, scheduleID: string, occurrenceID: string) {
  return requestJSON<ScheduleOccurrence>(
    `/api/sessions/${encodeURIComponent(sessionID)}/schedules/${encodeURIComponent(scheduleID)}/occurrences/${encodeURIComponent(occurrenceID)}`,
    { method: 'DELETE' },
  )
}

export async function listRepositorySkills(sessionID: string) {
  const response = await requestJSON<{ skills: RepositorySkill[] }>(
    `/api/sessions/${encodeURIComponent(sessionID)}/repository-skills`,
  )
  return response.skills
}

export async function getRepositorySkill(sessionID: string, name: string) {
  return requestJSON<RepositorySkill>(
    `/api/sessions/${encodeURIComponent(sessionID)}/repository-skills/${encodeURIComponent(name)}`,
  )
}

export async function createRepositorySkill(sessionID: string, input: RepositorySkillInput) {
  return requestJSON<RepositorySkill>(`/api/sessions/${encodeURIComponent(sessionID)}/repository-skills`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function updateRepositorySkill(sessionID: string, currentName: string, input: RepositorySkillInput) {
  return requestJSON<RepositorySkill>(
    `/api/sessions/${encodeURIComponent(sessionID)}/repository-skills/${encodeURIComponent(currentName)}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  )
}

export async function deleteRepositorySkill(sessionID: string, name: string) {
  return requestNoContent(
    `/api/sessions/${encodeURIComponent(sessionID)}/repository-skills/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  )
}

export async function repairRepositorySkillClaudeBridge(sessionID: string, name: string, replaceConflict = false) {
  return requestJSON<RepositorySkillBridgeRepair>(
    `/api/sessions/${encodeURIComponent(sessionID)}/repository-skills/${encodeURIComponent(name)}/claude-bridge`,
    {
      method: 'POST',
      ...(replaceConflict ? { body: JSON.stringify({ replace_conflict: true }) } : {}),
    },
  )
}

export async function repairRepositorySkillClaudeBridges(sessionID: string) {
  return requestJSON<{ skills: RepositorySkill[]; repaired: number }>(
    `/api/sessions/${encodeURIComponent(sessionID)}/repository-skills/repair-claude-bridges`,
    { method: 'POST' },
  )
}

export async function listUserSkills() {
  return requestJSON<UserSkillCatalog>('/api/user-skills')
}

export async function getUserSkill(name: string) {
  return requestJSON<RepositorySkill>(`/api/user-skills/${encodeURIComponent(name)}`)
}

export async function createUserSkill(input: RepositorySkillInput) {
  return requestJSON<RepositorySkill>('/api/user-skills', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function updateUserSkill(currentName: string, input: RepositorySkillInput) {
  return requestJSON<RepositorySkill>(`/api/user-skills/${encodeURIComponent(currentName)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export async function deleteUserSkill(name: string) {
  return requestNoContent(`/api/user-skills/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
}

export async function repairUserSkillClaudeBridge(name: string, replaceConflict = false) {
  return requestJSON<RepositorySkillBridgeRepair>(`/api/user-skills/${encodeURIComponent(name)}/claude-bridge`, {
    method: 'POST',
    ...(replaceConflict ? { body: JSON.stringify({ replace_conflict: true }) } : {}),
  })
}

export async function repairUserSkillClaudeBridges() {
  return requestJSON<{ skills: RepositorySkill[]; repaired: number }>('/api/user-skills/repair-claude-bridges', {
    method: 'POST',
  })
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
    return await requestJSON<{
      session_id: string
      request_id: string
      status: string
    }>(`/api/sessions/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(requestID)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ option_id: optionID }),
      signal: controller.signal,
    })
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
  maxBytes?: number
}

function eventListParams(params: Record<string, string>, options: EventListOptions) {
  const search = new URLSearchParams(params)
  if (options.includeDebug) {
    search.set('include_debug', 'true')
  }
  if (options.maxBytes !== undefined && options.maxBytes > 0) {
    search.set('max_bytes', String(Math.floor(options.maxBytes)))
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
  return data
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
  return data
}

export async function listEventTurnsAfter(
  sessionID: string,
  afterSeq: number,
  turns = defaultEventTurnPageSize,
  options: EventListOptions = {},
) {
  const params = eventListParams({ after_seq: String(afterSeq), turns: String(turns) }, options)
  return requestJSON<EventHistoryResponse>(withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/events`, params))
}

export async function listEventTurnsAround(
  sessionID: string,
  aroundSeq: number,
  turns = defaultEventTurnPageSize,
  options: EventListOptions = {},
) {
  const params = eventListParams({ around_seq: String(aroundSeq), turns: String(turns) }, options)
  return requestJSON<EventHistoryResponse>(withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/events`, params))
}

export function eventStreamURL(sessionID: string, afterSeq: number, options: EventListOptions = {}) {
  const params = eventListParams({ after_seq: String(afterSeq) }, options)
  return withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/events/stream`, params)
}

export function sessionActivityStreamURL(excludedSessionID?: string | null) {
  const params = new URLSearchParams()
  if (excludedSessionID) params.set('exclude_session_id', excludedSessionID)
  return withQuery('/api/sessions/activity/stream', params)
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

export async function getHostStatus(sessionID: string) {
  return requestJSON<HostStatus>(`/api/sessions/${encodeURIComponent(sessionID)}/host`)
}

export async function validateHost(sessionID: string) {
  return hostAction(sessionID, 'validate')
}

export async function startHost(sessionID: string) {
  return hostAction(sessionID, 'start')
}

export async function stopHost(sessionID: string) {
  return hostAction(sessionID, 'stop')
}

export async function restartHost(sessionID: string) {
  return hostAction(sessionID, 'restart')
}

export async function checkHost(sessionID: string) {
  return hostAction(sessionID, 'check')
}

export async function listHostLogs(sessionID: string, options: HostLogOptions = {}) {
  const params = new URLSearchParams()
  if (options.afterSeq !== undefined) params.set('after_seq', String(options.afterSeq))
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.service) params.set('service', options.service)
  return requestJSON<HostLogsResponse>(withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/host/logs`, params))
}

export function hostLogStreamURL(sessionID: string, afterSeq = 0, service?: string) {
  const params = new URLSearchParams({ after_seq: String(afterSeq) })
  if (service) params.set('service', service)
  return withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/host/logs/stream`, params)
}

function hostAction(sessionID: string, action: 'validate' | 'start' | 'stop' | 'restart' | 'check') {
  return requestJSON<HostStatus>(`/api/sessions/${encodeURIComponent(sessionID)}/host/${action}`, {
    method: 'POST',
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
