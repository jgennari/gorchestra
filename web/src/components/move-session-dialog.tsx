import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Session } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

type Props = {
  open: boolean
  session: Session | null
  sessions: Session[]
  onOpenChange: (open: boolean) => void
  onMove: (parentSessionID: string | null) => Promise<void>
}

export function MoveSessionDialog({ open, session, sessions, onOpenChange, onMove }: Props) {
  const [query, setQuery] = useState('')
  const [parentSessionID, setParentSessionID] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const excludedSessionIDs = useMemo(
    () => descendantSessionIDs(session?.id ?? null, sessions),
    [session?.id, sessions],
  )
  const candidates = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return sessions.filter((candidate) =>
      !excludedSessionIDs.has(candidate.id) &&
      (!normalizedQuery || candidate.title.toLowerCase().includes(normalizedQuery)),
    )
  }, [excludedSessionIDs, query, sessions])
  const selectedParent = parentSessionID
    ? sessions.find((candidate) => candidate.id === parentSessionID) ?? null
    : null
  const unchanged = (session?.parent_session_id || null) === parentSessionID

  useEffect(() => {
    if (!open) return
    setQuery('')
    setParentSessionID(session?.parent_session_id || null)
    setError('')
  }, [open, session?.id, session?.parent_session_id])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!session || unchanged) return
    setSubmitting(true)
    setError('')
    try {
      await onMove(parentSessionID)
      onOpenChange(false)
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : 'Failed to move session')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[min(42rem,calc(100dvh-4rem))] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle>Move under parent</DialogTitle>
          <DialogDescription>
            Organize {session?.title || 'this session'} without changing its workspace, agent, permissions, or history.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Search parent sessions"
          placeholder="Search parent sessions…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          disabled={submitting}
        />
        <ScrollArea className="min-h-0 rounded-md border border-border/80">
          <div role="radiogroup" aria-label="Parent session" className="space-y-1 p-2">
            {!query.trim() ? (
              <ParentOption
                title="Top level"
                detail="No parent session"
                selected={parentSessionID === null}
                onSelect={() => setParentSessionID(null)}
              />
            ) : null}
            {candidates.map((candidate) => (
              <ParentOption
                key={candidate.id}
                title={candidate.title || 'Untitled session'}
                detail={candidate.workspace_path}
                selected={parentSessionID === candidate.id}
                onSelect={() => setParentSessionID(candidate.id)}
              />
            ))}
            {candidates.length === 0 && query.trim() ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">No matching parent sessions.</p>
            ) : null}
          </div>
        </ScrollArea>
        <form className="space-y-3" onSubmit={(event) => void handleSubmit(event)}>
          <p className="text-sm text-muted-foreground">
            {parentSessionID && selectedParent
              ? <><span className="font-medium text-foreground">{session?.title}</span> will appear under <span className="font-medium text-foreground">{selectedParent.title}</span>.</>
              : <><span className="font-medium text-foreground">{session?.title}</span> will appear at the top level.</>}
          </p>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
            <Button type="submit" disabled={!session || unchanged || submitting}>{submitting ? 'Moving…' : 'Move'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ParentOption({
  title,
  detail,
  selected,
  onSelect,
}: {
  title: string
  detail: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'border-primary/40 bg-primary/10' : 'border-transparent hover:border-border hover:bg-accent',
      )}
    >
      <span className="truncate text-sm font-medium">{title}</span>
      <span className="truncate text-xs text-muted-foreground">{detail}</span>
    </button>
  )
}

function descendantSessionIDs(sessionID: string | null, sessions: Session[]) {
  const excluded = new Set<string>()
  if (!sessionID) return excluded
  excluded.add(sessionID)
  let changed = true
  while (changed) {
    changed = false
    for (const candidate of sessions) {
      if (candidate.parent_session_id && excluded.has(candidate.parent_session_id) && !excluded.has(candidate.id)) {
        excluded.add(candidate.id)
        changed = true
      }
    }
  }
  return excluded
}
