import { Send, Square } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

const maxPromptRows = 5
const fallbackLineHeight = 20

type Props = {
  disabled: boolean
  disabledReason: string
  onSubmit: (content: string) => Promise<void>
  onCancel?: () => Promise<void>
}

export function PromptComposer({ disabled, disabledReason, onSubmit, onCancel }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const canSubmit = !disabled && !submitting && content.trim().length > 0
  const canCancel = disabled && Boolean(onCancel)

  useLayoutEffect(() => {
    resizePromptTextarea(textareaRef.current)
  }, [content])

  async function submitPrompt() {
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

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    await submitPrompt()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter') {
      return
    }
    if (event.ctrlKey) {
      event.preventDefault()
      insertTextareaNewline(event.currentTarget, setContent)
      return
    }
    event.preventDefault()
    void submitPrompt()
  }

  async function handleCancel() {
    if (!onCancel || cancelling) {
      return
    }

    setCancelling(true)
    setError('')
    try {
      await onCancel()
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Failed to cancel run')
    } finally {
      setCancelling(false)
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="shrink-0 border-t bg-background p-3">
      <div className="flex gap-2">
        <Textarea
          ref={textareaRef}
          aria-label="Prompt"
          placeholder={disabled ? disabledReason : 'Ask the agent to work on this repository...'}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || submitting}
          rows={1}
          className="h-9 min-h-9 overflow-hidden py-2"
        />
        {canCancel ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            disabled={cancelling}
            onClick={() => void handleCancel()}
            className="self-end border-destructive/40 text-destructive hover:bg-destructive/10"
            aria-label="Cancel running session"
          >
            <Square />
          </Button>
        ) : (
          <Button type="submit" disabled={!canSubmit} className="self-end" aria-label="Submit prompt">
            <Send />
            <span className="hidden sm:inline">{submitting ? 'Sending' : 'Send'}</span>
          </Button>
        )}
      </div>
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
    </form>
  )
}

function resizePromptTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea) {
    return
  }

  textarea.style.height = 'auto'

  const styles = window.getComputedStyle(textarea)
  const lineHeight = parseFloat(styles.lineHeight) || fallbackLineHeight
  const paddingY = cssNumber(styles.paddingTop) + cssNumber(styles.paddingBottom)
  const borderY = cssNumber(styles.borderTopWidth) + cssNumber(styles.borderBottomWidth)
  const minHeight = lineHeight + paddingY + borderY
  const maxHeight = lineHeight * maxPromptRows + paddingY + borderY
  const scrollHeight = textarea.scrollHeight + borderY
  const nextHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight)

  textarea.style.height = `${nextHeight}px`
  textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden'
}

function cssNumber(value: string) {
  return parseFloat(value) || 0
}

function insertTextareaNewline(
  textarea: HTMLTextAreaElement,
  setContent: (content: string) => void,
) {
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const nextContent = `${textarea.value.slice(0, start)}\n${textarea.value.slice(end)}`
  const nextPosition = start + 1

  textarea.value = nextContent
  textarea.selectionStart = nextPosition
  textarea.selectionEnd = nextPosition
  setContent(nextContent)
  resizePromptTextarea(textarea)
}
