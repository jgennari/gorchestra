import {
  Brain,
  ChevronDown,
  ClipboardList,
  Send,
  SlidersHorizontal,
  Square,
  Zap,
} from 'lucide-react'
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  fetchAgentOptions,
  type AgentType,
  type CodexAgentOptions,
  type CodexModelOption,
  type CodexServiceTierOption,
  type SubmitAgentOptions,
} from '@/lib/api'
import { cn } from '@/lib/utils'

const maxPromptRows = 5
const fallbackLineHeight = 20
const codexSelectionStorageKey = 'gorchestra.codex.composer-options'

type Props = {
  agentType?: AgentType
  disabled: boolean
  disabledReason: string
  thinking?: boolean
  onSubmit: (content: string, agentOptions?: SubmitAgentOptions) => Promise<void>
  onCancel?: () => Promise<void>
}

type CodexSelection = {
  model: string
  reasoning_effort: string
  fast_mode: boolean
  planning_mode: boolean
}

export function PromptComposer({
  agentType = 'fake',
  disabled,
  disabledReason,
  thinking = false,
  onSubmit,
  onCancel,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const [codexOptions, setCodexOptions] = useState<CodexAgentOptions | null>(null)
  const [codexOptionsLoading, setCodexOptionsLoading] = useState(false)
  const [codexOptionsError, setCodexOptionsError] = useState('')
  const [codexSelection, setCodexSelection] = useState<CodexSelection>(loadCodexSelection)
  const canSubmit = !disabled && !submitting && content.trim().length > 0
  const canCancel = disabled && Boolean(onCancel)
  const codexToolbarVisible = agentType === 'codex'
  const selectedCodexModel = useMemo(
    () => selectedModel(codexOptions, codexSelection.model),
    [codexOptions, codexSelection.model],
  )
  const selectedFastTier = useMemo(() => fastTierForModel(selectedCodexModel), [selectedCodexModel])
  const codexControlsDisabled = disabled || submitting || codexOptionsLoading || !codexOptions

  useLayoutEffect(() => {
    resizePromptTextarea(textareaRef.current)
  }, [content])

  useEffect(() => {
    if (agentType !== 'codex') {
      return
    }

    let cancelled = false
    setCodexOptionsLoading(true)
    setCodexOptionsError('')
    void fetchAgentOptions('codex')
      .then((options) => {
        if (cancelled) return
        setCodexOptions(options)
        setCodexSelection((current) => reconcileCodexSelection(current, options))
      })
      .catch((loadError) => {
        if (cancelled) return
        setCodexOptionsError(loadError instanceof Error ? loadError.message : 'Failed to load Codex options')
      })
      .finally(() => {
        if (!cancelled) setCodexOptionsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [agentType])

  useEffect(() => {
    saveCodexSelection(codexSelection)
  }, [codexSelection])

  async function submitPrompt() {
    if (!canSubmit) {
      return
    }

    setSubmitting(true)
    setError('')
    try {
      if (codexToolbarVisible) {
        await onSubmit(content.trim(), submitOptionsForCodex(codexSelection, selectedFastTier))
      } else {
        await onSubmit(content.trim())
      }
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
    <form onSubmit={(event) => void handleSubmit(event)} className="relative shrink-0 p-3">
      {thinking ? <ThinkingIndicator /> : null}
      <div
        className={cn(
          'rounded-xl border border-border/90 bg-background/90 p-2 shadow-[0_10px_30px_hsl(var(--foreground)/0.10)] transition-colors',
          codexToolbarVisible && codexSelection.planning_mode && 'codex-plan-composer',
        )}
      >
        <Textarea
          ref={textareaRef}
          aria-label="Prompt"
          placeholder={disabled ? disabledReason : 'Ask the agent to work on this repository...'}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || submitting}
          rows={1}
          className="h-9 min-h-9 resize-none border-transparent bg-transparent px-1 py-2 shadow-none focus-visible:ring-0"
        />
        <div className="mt-2 flex min-h-9 items-center gap-2">
          {codexToolbarVisible ? (
            <CodexToolbar
              options={codexOptions}
              selection={codexSelection}
              loading={codexOptionsLoading}
              error={codexOptionsError}
              disabled={codexControlsDisabled}
              onChange={setCodexSelection}
            />
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {canCancel ? (
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={cancelling}
                onClick={() => void handleCancel()}
                className="border-destructive/40 text-destructive hover:bg-destructive/10"
                aria-label="Cancel running session"
              >
                <Square />
              </Button>
            ) : (
              <Button type="submit" disabled={!canSubmit} aria-label="Submit prompt">
                <Send />
                <span className="hidden sm:inline">{submitting ? 'Sending' : 'Send'}</span>
              </Button>
            )}
          </div>
        </div>
      </div>
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
    </form>
  )
}

function CodexToolbar({
  options,
  selection,
  loading,
  error,
  disabled,
  onChange,
}: {
  options: CodexAgentOptions | null
  selection: CodexSelection
  loading: boolean
  error: string
  disabled: boolean
  onChange: (selection: CodexSelection) => void
}) {
  const model = selectedModel(options, selection.model)
  const reasoningOptions = model?.supported_reasoning_efforts ?? []
  const fastTier = fastTierForModel(model)
  const planAvailable = Boolean(options?.collaboration_modes.some((mode) => mode.mode === 'plan'))

  if (loading && !options) {
    return <span className="text-xs font-medium text-muted-foreground">Loading Codex options...</span>
  }

  if (error && !options) {
    return <span className="text-xs font-medium text-destructive">Codex options unavailable</span>
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-medium text-muted-foreground">
      <SlidersHorizontal className="size-4 shrink-0" aria-hidden="true" />
      <OptionMenu
        label="Model"
        value={model?.display_name || selection.model || 'Model'}
        disabled={disabled || !options?.models.length}
        options={(options?.models ?? []).map((item) => ({ value: item.model, label: item.display_name }))}
        onSelect={(modelValue) => {
          onChange(reconcileCodexSelection({ ...selection, model: modelValue }, options))
        }}
      />
      <span aria-hidden="true" className="text-muted-foreground/70">
        ·
      </span>
      <OptionMenu
        label="Reasoning"
        value={selection.reasoning_effort || model?.default_reasoning_effort || 'Reasoning'}
        disabled={disabled || reasoningOptions.length === 0}
        options={reasoningOptions.map((item) => ({
          value: item.reasoning_effort,
          label: item.reasoning_effort,
          description: item.description,
        }))}
        onSelect={(reasoningEffort) => onChange({ ...selection, reasoning_effort: reasoningEffort })}
      />
      <span aria-hidden="true" className="text-muted-foreground/70">
        ·
      </span>
      <ToggleControl
        label="Fast"
        icon={<Zap className="size-4" aria-hidden="true" />}
        active={selection.fast_mode && Boolean(fastTier)}
        disabled={disabled || !fastTier}
        onClick={() => onChange({ ...selection, fast_mode: fastTier ? !selection.fast_mode : false })}
      />
      <ToggleControl
        label="Plan"
        icon={<ClipboardList className="size-4" aria-hidden="true" />}
        active={selection.planning_mode && planAvailable}
        disabled={disabled || !planAvailable}
        onClick={() => onChange({ ...selection, planning_mode: planAvailable ? !selection.planning_mode : false })}
      />
    </div>
  )
}

function OptionMenu({
  label,
  value,
  options,
  disabled,
  onSelect,
}: {
  label: string
  value: string
  options: { value: string; label: string; description?: string }[]
  disabled: boolean
  onSelect: (value: string) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-8 items-center gap-1 rounded-md px-1.5 text-sm font-semibold text-foreground/78 transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        <span className="max-w-40 truncate">{value}</span>
        <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label={label}
          className="absolute bottom-full left-0 z-50 mb-2 max-h-72 min-w-48 overflow-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-border/70"
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.label === value}
              onClick={() => {
                onSelect(option.value)
                setOpen(false)
              }}
              className="flex w-full flex-col rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/70"
            >
              <span className="font-medium">{option.label}</span>
              {option.description ? (
                <span className="max-w-72 truncate text-xs text-muted-foreground">{option.description}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ToggleControl({
  label,
  icon,
  active,
  disabled,
  onClick,
}: {
  label: string
  icon: ReactNode
  active: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-full px-2 text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50',
        active ? 'bg-primary/12 text-primary' : 'text-foreground/72 hover:text-foreground',
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function ThinkingIndicator() {
  const gradientId = `thinking-gradient-${useId().replace(/:/g, '')}`

  return (
    <div
      role="status"
      aria-label="Thinking"
      aria-live="polite"
      className="thinking-indicator pointer-events-none absolute bottom-[calc(100%+0.25rem)] left-4 z-10 inline-flex items-center gap-2 text-sm font-medium"
    >
      <Brain className="thinking-indicator__icon size-4" aria-hidden="true" stroke={`url(#${gradientId})`}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="24" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="hsl(var(--muted-foreground))" />
            <stop offset="42%" stopColor="hsl(var(--primary))" />
            <stop offset="58%" stopColor="hsl(var(--glow))" />
            <stop offset="100%" stopColor="hsl(var(--muted-foreground))" />
            <animateTransform
              attributeName="gradientTransform"
              type="translate"
              values="-24 0; 24 0; -24 0"
              dur="2.4s"
              repeatCount="indefinite"
            />
          </linearGradient>
        </defs>
      </Brain>
      <span className="thinking-indicator__text">Thinking</span>
    </div>
  )
}

function submitOptionsForCodex(
  selection: CodexSelection,
  fastTier: CodexServiceTierOption | null,
): SubmitAgentOptions {
  return {
    codex: {
      model: selection.model || undefined,
      reasoning_effort: selection.reasoning_effort || undefined,
      fast_mode: selection.fast_mode,
      planning_mode: selection.planning_mode,
      service_tier: selection.fast_mode ? fastTier?.id : undefined,
    },
  }
}

function reconcileCodexSelection(selection: CodexSelection, options: CodexAgentOptions | null): CodexSelection {
  if (!options || options.models.length === 0) {
    return selection
  }

  const model =
    options.models.find((item) => item.model === selection.model) ??
    options.models.find((item) => item.model === options.default_model) ??
    options.models.find((item) => item.is_default) ??
    options.models[0]
  const reasoningEfforts = model.supported_reasoning_efforts.map((item) => item.reasoning_effort)
  const reasoningEffort = reasoningEfforts.includes(selection.reasoning_effort)
    ? selection.reasoning_effort
    : model.default_reasoning_effort || reasoningEfforts[0] || ''
  const planAvailable = options.collaboration_modes.some((mode) => mode.mode === 'plan')

  return {
    model: model.model,
    reasoning_effort: reasoningEffort,
    fast_mode: selection.fast_mode && Boolean(fastTierForModel(model)),
    planning_mode: selection.planning_mode && planAvailable,
  }
}

function selectedModel(options: CodexAgentOptions | null, model: string) {
  if (!options) {
    return null
  }
  return (
    options.models.find((item) => item.model === model) ??
    options.models.find((item) => item.model === options.default_model) ??
    options.models.find((item) => item.is_default) ??
    options.models[0] ??
    null
  )
}

function fastTierForModel(model: CodexModelOption | null): CodexServiceTierOption | null {
  return model?.service_tiers.find((tier) => tier.name.toLowerCase() === 'fast') ?? null
}

function loadCodexSelection(): CodexSelection {
  try {
    const stored = window.localStorage.getItem(codexSelectionStorageKey)
    if (!stored) {
      return emptyCodexSelection()
    }
    const parsed = JSON.parse(stored) as Partial<CodexSelection>
    return {
      model: typeof parsed.model === 'string' ? parsed.model : '',
      reasoning_effort: typeof parsed.reasoning_effort === 'string' ? parsed.reasoning_effort : '',
      fast_mode: Boolean(parsed.fast_mode),
      planning_mode: Boolean(parsed.planning_mode),
    }
  } catch {
    return emptyCodexSelection()
  }
}

function saveCodexSelection(selection: CodexSelection) {
  try {
    window.localStorage.setItem(codexSelectionStorageKey, JSON.stringify(selection))
  } catch {
    // Keep the composer functional if storage is unavailable.
  }
}

function emptyCodexSelection(): CodexSelection {
  return {
    model: '',
    reasoning_effort: '',
    fast_mode: false,
    planning_mode: false,
  }
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
