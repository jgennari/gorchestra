export type SessionStatus = 'idle' | 'running' | 'failed'
export type AgentType = 'fake' | 'codex' | 'claude'

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
  pending_input?: boolean
  created_at: string
  updated_at: string
  completed_at: string | null
  archived_at: string | null
}

export type SessionAgentOptions = {
  codex?: {
    run_dangerously?: boolean
  }
  claude?: {
    run_dangerously?: boolean
  }
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

export type SubmitAgentOptions = {
  codex?: CodexSubmitOptions
  claude?: ClaudeSubmitOptions
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

type SubmitMessageResponse = {
  session_id: string
  status: SessionStatus
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

type ListSessionsOptions = {
  limit?: number
  status?: SessionStatus
}

export const defaultEventWindowLimit = 500

export class APIError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'APIError'
    this.status = status
  }
}

export function isAgentType(value: string): value is AgentType {
  return value === 'fake' || value === 'codex' || value === 'claude'
}

export async function fetchHealth() {
  await requestJSON<{ status: string }>('/api/health')
}

export async function listSessions(options: ListSessionsOptions | number = {}) {
  const limit = typeof options === 'number' ? options : (options.limit ?? 50)
  const status = typeof options === 'number' ? undefined : options.status
  const params = new URLSearchParams({ limit: String(limit) })
  if (status) {
    params.set('status', status)
  }

  const data = await requestJSON<ListSessionsResponse>(`/api/sessions?${params.toString()}`)
  return data.sessions
}

export async function getSession(sessionID: string) {
  return requestJSON<Session>(`/api/sessions/${encodeURIComponent(sessionID)}`)
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
  if (agentType !== 'codex') {
    throw new Error(`No options API for ${agentType}`)
  }
  return requestJSON<CodexAgentOptions>(`/api/agents/${encodeURIComponent(agentType)}/options`)
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
) {
  const body: {
    content: string
    agent_options?: SubmitAgentOptions
    attachments?: MessageAttachment[]
  } = { content }
  if (agentOptions) {
    body.agent_options = agentOptions
  }
  if (attachments.length > 0) {
    body.attachments = attachments
  }

  return requestJSON<SubmitMessageResponse>(`/api/sessions/${encodeURIComponent(sessionID)}/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
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

export async function listEvents(sessionID: string, afterSeq = 0, limit = 1000) {
  const data = await requestJSON<EventHistoryResponse>(
    `/api/sessions/${encodeURIComponent(sessionID)}/events?after_seq=${afterSeq}&limit=${limit}`,
  )
  return data.events
}

export async function listRecentEvents(sessionID: string, limit = defaultEventWindowLimit) {
  const params = new URLSearchParams({ tail: 'true', limit: String(limit) })
  const data = await requestJSON<EventHistoryResponse>(
    withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/events`, params),
  )
  return data.events
}

export async function listEventsBefore(sessionID: string, beforeSeq: number, limit = defaultEventWindowLimit) {
  const params = new URLSearchParams({ before_seq: String(beforeSeq), limit: String(limit) })
  const data = await requestJSON<EventHistoryResponse>(
    withQuery(`/api/sessions/${encodeURIComponent(sessionID)}/events`, params),
  )
  return data.events
}

export function eventStreamURL(sessionID: string, afterSeq: number) {
  return `/api/sessions/${encodeURIComponent(sessionID)}/events/stream?after_seq=${afterSeq}`
}

export function sessionActivityStreamURL() {
  return '/api/sessions/activity/stream'
}

function withQuery(path: string, params: URLSearchParams) {
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

async function requestJSON<T>(url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
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
