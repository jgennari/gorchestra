import {
  Brain,
  Bug,
  ChevronDown,
  ClipboardList,
  Paperclip,
  Send,
  SlidersHorizontal,
  Square,
  X,
  Zap,
} from 'lucide-react'
import {
  type DragEvent,
  type ChangeEvent,
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
  type MessageAttachment,
  type SubmitAgentOptions,
} from '@/lib/api'
import { cn } from '@/lib/utils'

const maxPromptRows = 5
const fallbackLineHeight = 20
const composerStorageKeyPrefix = 'gorchestra.session-composer.'
const defaultComposerStorageID = '__default__'
const maxImageAttachmentBytes = 5 * 1024 * 1024
const maxImageAttachmentCount = 8

type Props = {
  sessionID?: string
  agentType?: AgentType
  disabled: boolean
  disabledReason: string
  thinking?: boolean
  showDebugEvents?: boolean
  onSubmit: (content: string, agentOptions?: SubmitAgentOptions, attachments?: MessageAttachment[]) => Promise<void>
  onShowDebugEventsChange?: (showDebugEvents: boolean) => void
  onCancel?: () => Promise<void>
}

type CodexSelection = {
  model: string
  reasoning_effort: string
  fast_mode: boolean
  planning_mode: boolean
}

type ComposerStorageValue = {
  draft?: string
  codexSelection?: Partial<CodexSelection>
}

type ComposerAttachment = MessageAttachment & {
  id: string
}

export function PromptComposer({
  sessionID,
  agentType = 'fake',
  disabled,
  disabledReason,
  thinking = false,
  showDebugEvents = false,
  onSubmit,
  onShowDebugEventsChange,
  onCancel,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [content, setContent] = useState(() => loadDraft(sessionID))
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const [codexOptions, setCodexOptions] = useState<CodexAgentOptions | null>(null)
  const [codexOptionsLoading, setCodexOptionsLoading] = useState(false)
  const [codexOptionsError, setCodexOptionsError] = useState('')
  const [codexSelection, setCodexSelection] = useState<CodexSelection>(() => loadCodexSelection(sessionID))
  const hasAttachments = attachments.length > 0
  const canSubmit = !disabled && !submitting && (content.trim().length > 0 || hasAttachments)
  const canCancel = disabled && Boolean(onCancel)
  const inputDisabled = submitting
  const promptPlaceholder = disabled && canCancel
    ? 'Prepare your next message...'
    : disabled
      ? disabledReason
      : 'Ask the agent to work on this repository...'
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
    saveDraft(sessionID, content)
  }, [content, sessionID])

  useEffect(() => {
    saveCodexSelection(sessionID, codexSelection)
  }, [codexSelection, sessionID])

  async function submitPrompt() {
    if (!canSubmit) {
      return
    }

    setSubmitting(true)
    setError('')
    try {
      const submitAttachments = attachments.map(({ id: _id, ...attachment }) => attachment)
      if (codexToolbarVisible) {
        if (submitAttachments.length > 0) {
          await onSubmit(content.trim(), submitOptionsForCodex(codexSelection, selectedFastTier), submitAttachments)
        } else {
          await onSubmit(content.trim(), submitOptionsForCodex(codexSelection, selectedFastTier))
        }
      } else if (submitAttachments.length > 0) {
        await onSubmit(content.trim(), undefined, submitAttachments)
      } else {
        await onSubmit(content.trim())
      }
      setContent('')
      setAttachments([])
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

  async function handleFiles(files: FileList | File[]) {
    const selectedFiles = Array.from(files)
    if (selectedFiles.length === 0) {
      return
    }
    if (attachments.length + selectedFiles.length > maxImageAttachmentCount) {
      setError(`Attach up to ${maxImageAttachmentCount} images.`)
      return
    }

    const imageFiles: File[] = []
    for (const file of selectedFiles) {
      if (!file.type.startsWith('image/')) {
        setError('Only image attachments are supported.')
        return
      }
      if (file.size > maxImageAttachmentBytes) {
        setError(`${file.name} is larger than 5 MB.`)
        return
      }
      imageFiles.push(file)
    }

    try {
      const nextAttachments = await Promise.all(imageFiles.map(fileToAttachment))
      setAttachments((current) => [...current, ...nextAttachments])
      setError('')
    } catch (attachmentError) {
      setError(attachmentError instanceof Error ? attachmentError.message : 'Failed to attach image')
    }
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    void handleFiles(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (inputDisabled || !hasDraggedFiles(event)) {
      return
    }
    event.preventDefault()
    setDragActive(true)
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragActive(false)
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (inputDisabled || !hasDraggedFiles(event)) {
      return
    }
    event.preventDefault()
    setDragActive(false)
    void handleFiles(event.dataTransfer.files)
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="relative shrink-0 p-3">
      {thinking ? <ThinkingIndicator /> : null}
      <div
        data-testid="prompt-composer-dropzone"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'command-composer rounded-xl border border-border/90 p-2 shadow-[0_10px_30px_hsl(var(--foreground)/0.10)] transition-colors',
          codexToolbarVisible && codexSelection.planning_mode && 'codex-plan-composer',
          dragActive && 'border-primary/70 bg-primary/5 ring-2 ring-primary/20',
        )}
      >
        {attachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <ImageAttachmentPreview
                key={attachment.id}
                attachment={attachment}
                onRemove={() =>
                  setAttachments((current) => current.filter((item) => item.id !== attachment.id))
                }
              />
            ))}
          </div>
        ) : null}
        <Textarea
          ref={textareaRef}
          aria-label="Prompt"
          placeholder={promptPlaceholder}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={inputDisabled}
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
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              aria-label="Image attachments"
              onChange={handleFileInputChange}
            />
            {onShowDebugEventsChange ? (
              <ToggleControl
                label="Debug"
                icon={<Bug className="size-4" aria-hidden="true" />}
                active={showDebugEvents}
                disabled={false}
                iconOnly
                activeClassName="bg-orange-100 text-orange-800 dark:bg-orange-400/18 dark:text-orange-200"
                onClick={() => onShowDebugEventsChange(!showDebugEvents)}
              />
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={inputDisabled}
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach images"
              className="text-muted-foreground hover:text-foreground"
            >
              <Paperclip />
            </Button>
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

function ImageAttachmentPreview({
  attachment,
  onRemove,
}: {
  attachment: ComposerAttachment
  onRemove: () => void
}) {
  return (
    <figure className="group relative grid w-24 gap-1 rounded-lg border border-border/80 bg-surface-muted/70 p-1.5 shadow-sm">
      <div className="aspect-square overflow-hidden rounded-md bg-background">
        <img
          src={attachment.data_url}
          alt={attachment.name}
          className="h-full w-full object-cover"
        />
      </div>
      <figcaption className="min-w-0 truncate px-0.5 text-[10px] text-muted-foreground">
        {attachment.name}
      </figcaption>
      <button
        type="button"
        aria-label={`Remove ${attachment.name}`}
        onClick={onRemove}
        className="absolute right-0.5 top-0.5 inline-flex size-6 items-center justify-center rounded-full border border-border/80 bg-background/95 text-muted-foreground shadow-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </figure>
  )
}

function hasDraggedFiles(event: DragEvent<HTMLDivElement>) {
  return Array.from(event.dataTransfer.types).includes('Files')
}

async function fileToAttachment(file: File): Promise<ComposerAttachment> {
  const dataURL = await readFileAsDataURL(file)
  return {
    id: createAttachmentID(),
    name: file.name || 'image',
    media_type: file.type,
    data_url: dataURL,
    size_bytes: file.size,
  }
}

function readFileAsDataURL(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('Failed to read image attachment'))
      }
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image attachment'))
    reader.readAsDataURL(file)
  })
}

function createAttachmentID() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`
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
        activeClassName="bg-amber-100 text-amber-800 dark:bg-amber-400/18 dark:text-amber-200"
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
  iconOnly = false,
  activeClassName,
  onClick,
}: {
  label: string
  icon: ReactNode
  active: boolean
  disabled: boolean
  iconOnly?: boolean
  activeClassName?: string
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
        'inline-flex h-8 items-center gap-1.5 text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50',
        iconOnly ? 'w-8 justify-center rounded-md px-0' : 'rounded-full px-2',
        active ? (activeClassName ?? 'bg-primary/12 text-primary') : 'text-foreground/72 hover:text-foreground',
      )}
    >
      {icon}
      {iconOnly ? null : <span>{label}</span>}
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
      className="thinking-indicator pointer-events-none absolute bottom-[calc(100%-0.625rem)] left-4 z-10 inline-flex items-center gap-2 text-sm font-medium"
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

function composerStorageKey(sessionID: string | undefined) {
  return `${composerStorageKeyPrefix}${sessionID || defaultComposerStorageID}`
}

function loadComposerStorage(sessionID: string | undefined): ComposerStorageValue {
  try {
    const stored = window.localStorage.getItem(composerStorageKey(sessionID))
    if (!stored) {
      return {}
    }
    const parsed = JSON.parse(stored) as ComposerStorageValue
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function saveComposerStorage(sessionID: string | undefined, value: ComposerStorageValue) {
  try {
    window.localStorage.setItem(composerStorageKey(sessionID), JSON.stringify(value))
  } catch {
    // Keep the composer functional if storage is unavailable.
  }
}

function loadDraft(sessionID: string | undefined) {
  const stored = loadComposerStorage(sessionID)
  return typeof stored.draft === 'string' ? stored.draft : ''
}

function saveDraft(sessionID: string | undefined, draft: string) {
  saveComposerStorage(sessionID, {
    ...loadComposerStorage(sessionID),
    draft,
  })
}

function loadCodexSelection(sessionID: string | undefined): CodexSelection {
  const stored = loadComposerStorage(sessionID).codexSelection ?? {}
  return {
    model: typeof stored.model === 'string' ? stored.model : '',
    reasoning_effort: typeof stored.reasoning_effort === 'string' ? stored.reasoning_effort : '',
    fast_mode: Boolean(stored.fast_mode),
    planning_mode: Boolean(stored.planning_mode),
  }
}

function saveCodexSelection(sessionID: string | undefined, selection: CodexSelection) {
  saveComposerStorage(sessionID, {
    ...loadComposerStorage(sessionID),
    codexSelection: selection,
  })
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
