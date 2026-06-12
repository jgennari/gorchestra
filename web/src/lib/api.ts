export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
export type AgentType = 'fake' | 'codex'
export type SessionListFilter = 'all' | Exclude<SessionStatus, 'idle'>

export type Session = {
  id: string
  title: string
  agent_type: AgentType
  status: SessionStatus
  created_at: string
  updated_at: string
  completed_at: string | null
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

type ErrorResponse = {
  error?: string
}

type ListSessionsResponse = {
  sessions: Session[]
}

type CreateSessionResponse = {
  session_id: string
}

type SubmitMessageResponse = {
  session_id: string
  status: SessionStatus
}

type CancelSessionResponse = {
  session_id: string
  status: 'cancelling'
}

type EventHistoryResponse = {
  events: AgentEvent[]
}

type ListSessionsOptions = {
  limit?: number
  status?: SessionStatus
}

export class APIError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'APIError'
    this.status = status
  }
}

export function isAgentType(value: string): value is AgentType {
  return value === 'fake' || value === 'codex'
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

export async function createSession(params: { agent_type: AgentType; title?: string }) {
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

export async function submitMessage(sessionID: string, content: string) {
  return requestJSON<SubmitMessageResponse>(`/api/sessions/${encodeURIComponent(sessionID)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  })
}

export async function cancelSession(sessionID: string) {
  return requestJSON<CancelSessionResponse>(`/api/sessions/${encodeURIComponent(sessionID)}/cancel`, {
    method: 'POST',
  })
}

export async function listEvents(sessionID: string, afterSeq = 0, limit = 1000) {
  const data = await requestJSON<EventHistoryResponse>(
    `/api/sessions/${encodeURIComponent(sessionID)}/events?after_seq=${afterSeq}&limit=${limit}`,
  )
  return data.events
}

export function eventStreamURL(sessionID: string, afterSeq: number) {
  return `/api/sessions/${encodeURIComponent(sessionID)}/events/stream?after_seq=${afterSeq}`
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
