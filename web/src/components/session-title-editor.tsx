import { Check, Pencil, X } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

type Props = {
  title: string
  onSave: (title: string) => Promise<void>
}

export function SessionTitleEditor({ title, onSave }: Props) {
  const inputID = useId()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const [saving, setSaving] = useState(false)
  const [pendingTitle, setPendingTitle] = useState<string | null>(null)
  const [error, setError] = useState('')
  const displayTitle = pendingTitle ?? title

  useEffect(() => {
    if (!editing && !saving) {
      setDraft(title)
    }
  }, [editing, saving, title])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const nextTitle = draft.trim()

    setSaving(true)
    setEditing(false)
    setPendingTitle(nextTitle)
    setError('')

    try {
      await onSave(nextTitle)
      setPendingTitle(null)
    } catch (saveError) {
      setPendingTitle(null)
      setEditing(true)
      setError(saveError instanceof Error ? saveError.message : 'Failed to update title')
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <form onSubmit={(event) => void handleSubmit(event)} className="min-w-0">
        <label htmlFor={inputID} className="sr-only">
          Session title
        </label>
        <div className="flex min-w-0 items-center gap-2">
          <Input
            id={inputID}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            autoFocus
            aria-invalid={error ? 'true' : undefined}
            className="h-8 min-w-0 max-w-xl"
          />
          <Button type="submit" size="icon" aria-label="Save session title" disabled={saving}>
            <Check />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Cancel title edit"
            disabled={saving}
            onClick={() => {
              setDraft(title)
              setEditing(false)
              setError('')
            }}
          >
            <X />
          </Button>
        </div>
        {error ? (
          <p role="alert" className="mt-1 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </form>
    )
  }

  return (
    <TooltipProvider>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-lg font-semibold">{displayTitle || 'Untitled session'}</h2>
          {saving ? <Badge variant="outline">Saving</Badge> : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Edit session title"
                disabled={saving}
                onClick={() => {
                  setDraft(title)
                  setEditing(true)
                  setError('')
                }}
                className="h-8 w-8"
              >
                <Pencil />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Edit title</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  )
}
