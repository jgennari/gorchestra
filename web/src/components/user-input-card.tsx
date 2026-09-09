import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { UserInputAnswers, UserInputQuestion } from '@/lib/api'
import type { PendingUserInputRequest } from '@/lib/events'
import { cn } from '@/lib/utils'

type Props = {
  request: PendingUserInputRequest | null
  disabled?: boolean
  onAnswer: (requestID: string, answers: UserInputAnswers) => Promise<void>
}

export function UserInputCard({ request, disabled = false, onAnswer }: Props) {
  disabled = disabled || Boolean(request?.submitting || request?.deliveryError)
  const [pageIndex, setPageIndex] = useState(0)
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({})
  const [otherValues, setOtherValues] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const otherInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setPageIndex(0)
    setSelections({})
    setConfirmed({})
    setOtherValues({})
    setSubmitting(false)
    setError('')
  }, [request?.requestID])

  const question = request?.questions[pageIndex] ?? null
  const selectedValues = question ? selections[question.id] ?? [] : []
  const optionLabels = useMemo(() => new Set(question?.options.map((option) => option.label) ?? []), [question])
  const otherSelected = selectedValues.some((value) => !optionLabels.has(value)) || Boolean(question?.multi_select && otherValues[question.id]?.trim())
  const multiValues = question?.multi_select
    ? [...new Set([...selectedValues.filter((value) => optionLabels.has(value)), ...(otherValues[question.id]?.trim() ? [otherValues[question.id].trim()] : [])])]
    : []

  if (!request || !question) {
    return null
  }

  async function commitAnswer(values: string[]) {
    if (!request || !question || disabled || submitting) {
      return
    }

    if (values.length === 0) {
      return
    }

    const nextSelections = { ...selections, [question.id]: values }
    const nextConfirmed = { ...confirmed, [question.id]: true }
    setSelections(nextSelections)
    setConfirmed(nextConfirmed)
    setError('')

    const nextUnansweredIndex = request.questions.findIndex((item) => !nextConfirmed[item.id])
    if (nextUnansweredIndex >= 0) {
      setPageIndex(nextUnansweredIndex)
      return
    }

    setSubmitting(true)
    try {
      await onAnswer(request.requestID, answersFromSelections(request.questions, nextSelections))
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to submit answer')
      setSubmitting(false)
    }
  }

  function selectAnswer(value: string) {
    if (!question || disabled || submitting || !value.trim()) return
    if (question.multi_select) {
      setSelections((current) => {
        const values = current[question.id] ?? []
        return { ...current, [question.id]: values.includes(value) ? values.filter((item) => item !== value) : [...values, value] }
      })
      setConfirmed((current) => ({ ...current, [question.id]: false }))
      setError('')
      return
    }
    void commitAnswer([value.trim()])
  }

  function selectOther() {
    if (!question) {
      return
    }
    const value = otherValues[question.id] ?? ''
    if (question.multi_select || !value.trim()) {
      otherInputRef.current?.focus()
      return
    }
    void selectAnswer(value)
  }

  return (
    <section
      role="group"
      aria-label="Agent question"
      className="mx-3 max-h-[min(60dvh,32rem)] overflow-y-auto overscroll-contain rounded-xl border border-border/90 bg-background/95 p-3 shadow-[0_16px_40px_hsl(var(--foreground)/0.14)] backdrop-blur"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold uppercase tracking-normal text-muted-foreground">
            {question.header || 'Question'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-md border border-border/70 text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            aria-label="Previous question"
            disabled={pageIndex === 0 || submitting}
            onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </button>
          <span className="min-w-10 text-center text-xs tabular-nums text-muted-foreground">
            {pageIndex + 1}/{request.questions.length}
          </span>
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-md border border-border/70 text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            aria-label="Next question"
            disabled={pageIndex >= request.questions.length - 1 || submitting}
            onClick={() => setPageIndex((current) => Math.min(request.questions.length - 1, current + 1))}
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="mb-3">
        <h3 className="mt-1 text-sm font-semibold leading-snug">{question.question}</h3>
        {question.multi_select ? <p className="mt-1 text-xs text-muted-foreground">Select all that apply, then continue.</p> : null}
        {request.delivery === 'async' ? (
          <p className="mt-1 text-xs text-muted-foreground">The agent is still working. Your answer goes to this run immediately.</p>
        ) : null}
      </div>

      <div className="grid gap-1.5">
        {question.options.map((option) => (
          <button
            key={option.label}
            type="button"
            disabled={disabled || submitting}
            role={question.multi_select ? 'checkbox' : undefined}
            aria-checked={question.multi_select ? selectedValues.includes(option.label) : undefined}
            onClick={() => selectAnswer(option.label)}
            className={cn(
              'flex min-h-12 w-full min-w-0 items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors disabled:pointer-events-none disabled:opacity-60 sm:items-center',
              selectedValues.includes(option.label)
                ? 'border-primary/60 bg-primary/10 text-foreground'
                : 'border-border/72 bg-transparent text-foreground hover:border-border',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'mt-1.5 size-2.5 shrink-0 border sm:mt-0',
                question.multi_select ? 'rounded-sm' : 'rounded-full',
                selectedValues.includes(option.label) ? 'border-primary bg-primary' : 'border-muted-foreground/35',
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block whitespace-normal break-words text-sm font-medium leading-snug sm:truncate">
                {option.label}
              </span>
              {option.description ? (
                <span className="mt-0.5 block whitespace-normal break-words text-xs leading-snug text-muted-foreground sm:truncate">
                  {option.description}
                </span>
              ) : null}
            </span>
          </button>
        ))}

        {question.is_other ? (
          <div
            role="button"
            tabIndex={disabled || submitting ? -1 : 0}
            onClick={selectOther}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                selectOther()
              }
            }}
            className={cn(
              'flex min-h-12 w-full min-w-0 items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors disabled:pointer-events-none disabled:opacity-60',
              otherSelected ? 'border-primary/60 bg-primary/10 text-foreground' : 'border-border/72 bg-transparent',
              disabled || submitting ? 'pointer-events-none opacity-60' : '',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'size-2.5 shrink-0 rounded-full border',
                otherSelected ? 'border-primary bg-primary' : 'border-muted-foreground/35',
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Other</span>
              <input
                ref={otherInputRef}
                aria-label={`Other answer for ${question.question}`}
                type={question.is_secret ? 'password' : 'text'}
                value={otherValues[question.id] ?? ''}
                disabled={disabled || submitting}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => {
                  setOtherValues((current) => ({ ...current, [question.id]: event.target.value }))
                  if (question.multi_select) setConfirmed((current) => ({ ...current, [question.id]: false }))
                }}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    if (question.multi_select) void commitAnswer(multiValues)
                    else selectAnswer(event.currentTarget.value)
                  }
                }}
                className="mt-1 h-7 w-full rounded border border-border/70 bg-background px-2 text-sm outline-none focus:border-primary"
              />
            </span>
          </div>
        ) : null}
      </div>

      {question.multi_select ? (
        <button
          type="button"
          disabled={disabled || submitting || multiValues.length === 0}
          onClick={() => void commitAnswer(multiValues)}
          className="mt-3 min-h-10 w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {request.questions.some((item) => item.id !== question.id && !confirmed[item.id]) ? 'Continue' : 'Send answers'}
        </button>
      ) : null}

      {!request.deliveryError && (submitting || request.submitting) ? <p role="status" className="mt-2 text-xs text-muted-foreground">Sending answer…</p> : null}
      {request.deliveryError || error ? <p role="alert" className="mt-2 text-xs text-destructive">{request.deliveryError || error}</p> : null}
    </section>
  )
}

function answersFromSelections(questions: UserInputQuestion[], selections: Record<string, string[]>): UserInputAnswers {
  const answers: UserInputAnswers = {}
  for (const question of questions) {
    answers[question.id] = {
      answers: selections[question.id],
    }
  }
  return answers
}
