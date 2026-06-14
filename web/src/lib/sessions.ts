import type { Session } from '@/lib/api'

export function nextSessionIDAfterArchive(
  sessions: Pick<Session, 'id'>[],
  archivedSessionID: string,
  selectedSessionID: string | null,
) {
  if (selectedSessionID !== archivedSessionID) {
    return selectedSessionID
  }

  const archivedIndex = sessions.findIndex((session) => session.id === archivedSessionID)
  const remaining = sessions.filter((session) => session.id !== archivedSessionID)
  if (archivedIndex < 0) {
    return remaining[0]?.id ?? null
  }

  return remaining[archivedIndex]?.id ?? remaining[archivedIndex - 1]?.id ?? remaining[0]?.id ?? null
}
