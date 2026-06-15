import type { Session } from '@/lib/api'

export type SessionAttention = 'pending-input' | 'unseen-idle'

export function sessionAttention(
  session: Session,
  lastSeenSeqBySession: Record<string, number>,
): SessionAttention | null {
  if (session.pending_input) {
    return 'pending-input'
  }
  if (session.status === 'idle' && latestSessionSeq(session) > (lastSeenSeqBySession[session.id] ?? 0)) {
    return 'unseen-idle'
  }
  return null
}

export function hasSessionAttention(sessions: Session[], lastSeenSeqBySession: Record<string, number>) {
  return sessions.some((session) => sessionAttention(session, lastSeenSeqBySession) !== null)
}

export function latestSessionSeq(session: Session | null) {
  if (!session) {
    return 0
  }
  return Math.max(session.last_event_seq ?? 0, session.event_count ?? 0)
}
