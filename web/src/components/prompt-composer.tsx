import { Send } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

type Props = {
  disabled: boolean
  disabledReason: string
  onSubmit: (content: string) => Promise<void>
}

export function PromptComposer({ disabled, disabledReason, onSubmit }: Props) {
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const canSubmit = !disabled && !submitting && content.trim().length > 0

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!canSubmit) {
      return
    }

    setSubmitting(true)
    setError('')
    try {
      await onSubmit(content.trim())
      setContent('')
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to submit prompt')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="border-t bg-background p-3">
      <div className="flex gap-2">
        <Textarea
          aria-label="Prompt"
          placeholder={disabled ? disabledReason : 'Ask the agent to work on this repository...'}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          disabled={disabled || submitting}
          className="min-h-20"
        />
        <Button type="submit" disabled={!canSubmit} className="self-end" aria-label="Submit prompt">
          <Send />
          <span className="hidden sm:inline">{submitting ? 'Sending' : 'Send'}</span>
        </Button>
      </div>
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
    </form>
  )
}
