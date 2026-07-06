import type { AgentType, SessionStatus } from '@/lib/api'

export type SessionListStatusFilter = 'all' | SessionStatus | 'pending-input'
export type SessionListAgentFilter = 'all' | AgentType

export type SessionListFilters = {
  status: SessionListStatusFilter
  agent: SessionListAgentFilter
  attentionOnly: boolean
  includeArchived: boolean
}

export const defaultSessionListFilters: SessionListFilters = {
  status: 'all',
  agent: 'all',
  attentionOnly: false,
  includeArchived: false,
}
