import type { Session } from '@/lib/api'
import { hasSessionAttention, latestSessionSeq, sessionAttention } from '@/lib/session-attention'

const baseSession: Session = {
  id: 'sess_1',
  title: 'Inspect repo',
  agent_type: 'codex',
  status: 'idle',
  workspace_path: '/repo',
  event_count: 4,
  tool_count: 0,
  last_event_seq: 4,
  created_at: '2026-06-12T16:00:00Z',
  updated_at: '2026-06-12T16:00:00Z',
  completed_at: null,
  archived_at: null,
}

test('session attention prioritizes pending input', () => {
  const session = { ...baseSession, pending_input: true }

  expect(sessionAttention(session, { sess_1: 4 })).toBe('pending-input')
  expect(hasSessionAttention([session], { sess_1: 4 })).toBe(true)
})

test('session attention marks unseen idle results', () => {
  expect(sessionAttention(baseSession, { sess_1: 2 })).toBe('unseen-idle')
  expect(hasSessionAttention([baseSession], { sess_1: 2 })).toBe(true)
})

test('session attention ignores seen sessions and non-idle updates', () => {
  expect(sessionAttention(baseSession, { sess_1: 4 })).toBeNull()
  expect(sessionAttention({ ...baseSession, status: 'running' }, { sess_1: 2 })).toBeNull()
  expect(hasSessionAttention([baseSession], { sess_1: 4 })).toBe(false)
})

test('latest session seq handles empty sessions and falls back to event count', () => {
  expect(latestSessionSeq(null)).toBe(0)
  expect(latestSessionSeq({ ...baseSession, last_event_seq: undefined, event_count: 7 })).toBe(7)
})
