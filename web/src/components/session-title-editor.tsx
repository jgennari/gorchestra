import { Loader2 } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type SessionTitleProps = {
  title: string
}

export function SessionTitle({ title }: SessionTitleProps) {
  return (
    <h2 className="min-w-0 truncate text-base font-semibold tracking-tight" title={title || undefined}>
      {title || 'Untitled session'}
    </h2>
  )
}

type SessionRenameFormProps = {
  title: string
  onSave: (title: string) => Promise<void>
}

export function SessionRenameForm({ title, onSave }: SessionRenameFormProps) {
  const inputID = useId()
  const [draft, setDraft] = useState(title)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const nextTitle = draft.trim()
  const dirty = nextTitle !== title

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!dirty || saving) return

    setSaving(true)
    setError('')
    try {
      await onSave(nextTitle)
      setDraft(nextTitle)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to update session name')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="space-y-2">
      <label htmlFor={inputID} className="text-xs font-medium text-muted-foreground">
        Session name
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={inputID}
          value={draft}
          autoFocus
          onChange={(event) => {
            setDraft(event.target.value)
            setError('')
          }}
          aria-invalid={error ? 'true' : undefined}
          disabled={saving}
          className="h-8 min-w-0 bg-background/70"
        />
        <Button type="submit" size="sm" disabled={!dirty || saving} aria-label="Save session name">
          {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          {saving ? 'Saving' : 'Save'}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  )
}
