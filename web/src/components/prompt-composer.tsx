import {
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
  type ClipboardEvent,
  type DragEvent,
  type ChangeEvent,
  useEffect,
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
  type AgentEvent,
  fetchAgentOptions,
  fetchQueuedMessages,
  type AgentType,
  type CodexAgentOptions,
  type CodexModelOption,
  type CodexServiceTierOption,
  type MessageAttachment,
  type QueuedMessage,
  removeQueuedMessage as deleteQueuedMessage,
  type SubmitAgentOptions,
} from '@/lib/api'
import { cn } from '@/lib/utils'

const maxPromptRows = 5
const fallbackLineHeight = 20
const composerStorageKeyPrefix = 'gorchestra.session-composer.'
const defaultComposerStorageID = '__default__'
const maxImageAttachmentBytes = 5 * 1024 * 1024
const maxImageAttachmentCount = 8
const maxQueuedMessages = 5
const queueShortcutLabel = 'Cmd/Ctrl+Shift+Enter'
const claudeModelOptions = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
]
const claudeEffortOptions = ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value }))

type Props = {
  sessionID?: string
  agentType?: AgentType
  sessionStatus?: 'idle' | 'running' | 'failed'
  hasPendingUserInput?: boolean
  latestTerminalEvent?: AgentEvent | null
  latestQueueEvent?: AgentEvent | null
  disabled: boolean
  disabledReason: string
  showDebugEvents?: boolean
  onSubmit: (
    content: string,
    agentOptions?: SubmitAgentOptions,
    attachments?: MessageAttachment[],
    queue?: boolean,
  ) => Promise<void>
  onShowDebugEventsChange?: (showDebugEvents: boolean) => void
  onCancel?: () => Promise<void>
  onError?: (message: string) => void
}

type CodexSelection = {
  model: string
  reasoning_effort: string
  fast_mode: boolean
  planning_mode: boolean
}

type ClaudeSelection = {
  model: string
  effort: string
  planning_mode: boolean
}

type ComposerStorageValue = {
  draft?: string
  codexSelection?: Partial<CodexSelection>
  claudeSelection?: Partial<ClaudeSelection>
}

type ComposerAttachment = MessageAttachment & {
  id: string
}

export function PromptComposer({
  sessionID,
  agentType = 'fake',
  sessionStatus = 'idle',
  latestTerminalEvent = null,
  latestQueueEvent = null,
  disabled,
  disabledReason,
  showDebugEvents = false,
  onSubmit,
  onShowDebugEventsChange,
  onCancel,
  onError,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [content, setContent] = useState(() => loadDraft(sessionID))
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([])
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [codexOptions, setCodexOptions] = useState<CodexAgentOptions | null>(null)
  const [codexOptionsLoading, setCodexOptionsLoading] = useState(false)
  const [codexOptionsError, setCodexOptionsError] = useState('')
  const [codexSelection, setCodexSelection] = useState<CodexSelection>(() => loadCodexSelection(sessionID))
  const [claudeSelection, setClaudeSelection] = useState<ClaudeSelection>(() => loadClaudeSelection(sessionID))
  const hasAttachments = attachments.length > 0
  const canSubmit = !disabled && !submitting && (content.trim().length > 0 || hasAttachments)
  const queueBlockedByAttachments = hasAttachments
  const canQueue =
    !submitting && content.trim().length > 0 && !queueBlockedByAttachments && queuedMessages.length < maxQueuedMessages
  const canCancel = disabled && Boolean(onCancel)
  const inputDisabled = submitting
  const promptPlaceholder =
    disabled && canCancel
      ? 'Prepare your next message...'
      : disabled
        ? disabledReason
        : 'Ask the agent to work on this repository...'
  const codexToolbarVisible = agentType === 'codex'
  const claudeToolbarVisible = agentType === 'claude'
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
    if (!sessionID) {
      setQueuedMessages([])
      return
    }

    let cancelled = false
    void fetchQueuedMessages(sessionID)
      .then((response) => {
        if (!cancelled) setQueuedMessages(Array.isArray(response.messages) ? response.messages : [])
      })
      .catch((queueError) => {
        if (!cancelled) onError?.(queueError instanceof Error ? queueError.message : 'Failed to load queued messages')
      })

    return () => {
      cancelled = true
    }
  }, [latestQueueEvent?.seq, latestTerminalEvent?.seq, sessionID, onError])

  useEffect(() => {
    saveCodexSelection(sessionID, codexSelection)
  }, [codexSelection, sessionID])

  useEffect(() => {
    saveClaudeSelection(sessionID, claudeSelection)
  }, [claudeSelection, sessionID])

  function currentSubmitOptions() {
    if (codexToolbarVisible) {
      return submitOptionsForCodex(codexSelection, selectedFastTier)
    }
    if (claudeToolbarVisible) {
      return submitOptionsForClaude(claudeSelection)
    }
    return undefined
  }

  async function submitText(contentToSend: string, submitAttachments: MessageAttachment[] = [], queue = false) {
    const submitOptions = currentSubmitOptions()

    if (queue) {
      await onSubmit(contentToSend, submitOptions, submitAttachments.length > 0 ? submitAttachments : undefined, true)
      return
    }
    if (submitOptions && submitAttachments.length > 0) {
      await onSubmit(contentToSend, submitOptions, submitAttachments)
      return
    }
    if (submitOptions) {
      await onSubmit(contentToSend, submitOptions)
      return
    }
    if (submitAttachments.length > 0) {
      await onSubmit(contentToSend, undefined, submitAttachments)
      return
    }
    await onSubmit(contentToSend)
  }

  function restoreTextareaFocus() {
    window.setTimeout(() => {
      window.requestAnimationFrame(() => {
        textareaRef.current?.focus({ preventScroll: true })
      })
    }, 0)
  }

  async function submitPrompt(forceRestoreFocus = false) {
    if (!canSubmit) {
      return
    }

    const restorePromptFocus = forceRestoreFocus || document.activeElement === textareaRef.current
    setSubmitting(true)
    onError?.('')
    try {
      const submitAttachments = attachments.map((attachment) => ({
        name: attachment.name,
        media_type: attachment.media_type,
        data_url: attachment.data_url,
        size_bytes: attachment.size_bytes,
      }))
      await submitText(content.trim(), submitAttachments)
      setContent('')
      setAttachments([])
    } catch (submitError) {
      onError?.(submitError instanceof Error ? submitError.message : 'Failed to submit prompt')
    } finally {
      setSubmitting(false)
      if (restorePromptFocus) {
        restoreTextareaFocus()
      }
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
    if ((event.metaKey || event.ctrlKey) && event.shiftKey) {
      event.preventDefault()
      void enqueueDraft(true)
      return
    }
    if (event.shiftKey) {
      event.preventDefault()
      insertTextareaNewline(event.currentTarget, setContent)
      return
    }
    if (sessionStatus === 'running') {
      event.preventDefault()
      void enqueueDraft(true)
      return
    }
    event.preventDefault()
    void submitPrompt(true)
  }

  async function handleCancel() {
    if (!onCancel || cancelling) {
      return
    }

    setCancelling(true)
    onError?.('')
    try {
      await onCancel()
    } catch (cancelError) {
      onError?.(cancelError instanceof Error ? cancelError.message : 'Failed to cancel run')
    } finally {
      setCancelling(false)
    }
  }

  async function enqueueDraft(forceRestoreFocus = false) {
    const trimmed = content.trim()
    if (!trimmed) {
      return
    }
    if (queueBlockedByAttachments) {
      onError?.('Queued messages cannot include image attachments.')
      return
    }
    if (queuedMessages.length >= maxQueuedMessages) {
      onError?.(`Queue up to ${maxQueuedMessages} messages.`)
      return
    }
    const restorePromptFocus =
      forceRestoreFocus ||
      document.activeElement === textareaRef.current ||
      document.activeElement instanceof HTMLButtonElement
    setSubmitting(true)
    onError?.('')
    try {
      await submitText(trimmed, [], true)
      setContent('')
      if (sessionID) {
        const response = await fetchQueuedMessages(sessionID)
        setQueuedMessages(Array.isArray(response.messages) ? response.messages : [])
      }
    } catch (queueError) {
      onError?.(queueError instanceof Error ? queueError.message : 'Failed to queue prompt')
    } finally {
      setSubmitting(false)
      if (restorePromptFocus) {
        restoreTextareaFocus()
      }
    }
  }

  async function removeQueuedDraft(queuedMessageID: string) {
    if (!sessionID) {
      return
    }
    onError?.('')
    try {
      await deleteQueuedMessage(sessionID, queuedMessageID)
      const response = await fetchQueuedMessages(sessionID)
      setQueuedMessages(Array.isArray(response.messages) ? response.messages : [])
    } catch (removeError) {
      onError?.(removeError instanceof Error ? removeError.message : 'Failed to remove queued prompt')
    }
  }

  async function handleFiles(files: FileList | File[]) {
    const selectedFiles = Array.from(files)
    if (selectedFiles.length === 0) {
      return
    }
    if (attachments.length + selectedFiles.length > maxImageAttachmentCount) {
      onError?.(`Attach up to ${maxImageAttachmentCount} images.`)
      return
    }

    const imageFiles: File[] = []
    for (const file of selectedFiles) {
      if (!file.type.startsWith('image/')) {
        onError?.('Only image attachments are supported.')
        return
      }
      if (file.size > maxImageAttachmentBytes) {
        onError?.(`${file.name} is larger than 5 MB.`)
        return
      }
      imageFiles.push(file)
    }

    try {
      const nextAttachments = await Promise.all(imageFiles.map(fileToAttachment))
      setAttachments((current) => [...current, ...nextAttachments])
      onError?.('')
    } catch (attachmentError) {
      onError?.(attachmentError instanceof Error ? attachmentError.message : 'Failed to attach image')
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

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    if (inputDisabled) {
      return
    }
    const imageFiles = clipboardImageFiles(event.clipboardData)
    if (imageFiles.length === 0) {
      return
    }
    event.preventDefault()
    void handleFiles(imageFiles)
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="relative shrink-0 p-3">
      {queuedMessages.length > 0 ? (
        <div className="pointer-events-auto relative z-0 mx-3 -mb-3 rounded-t-[20px] border border-border/85 border-b-0 bg-surface-muted/75 px-4 pb-4 pt-2 shadow-[0_10px_24px_hsl(var(--foreground)/0.08)] backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Queued {queuedMessages.length}/{maxQueuedMessages}
            </p>
            <p className="hidden text-xs text-muted-foreground sm:block">{queueShortcutLabel}</p>
          </div>
          <div className="mt-1.5">
            {queuedMessages.map((message, index) => (
              <QueuedMessageRow
                key={message.id}
                index={index}
                message={message.content}
                onRemove={() => void removeQueuedDraft(message.id)}
              />
            ))}
          </div>
        </div>
      ) : null}
      <div
        data-testid="prompt-composer-dropzone"
        onPaste={handlePaste}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'command-composer relative z-10 rounded-xl border border-border/90 p-2 shadow-[0_10px_30px_hsl(var(--foreground)/0.10)] transition-colors',
          ((codexToolbarVisible && codexSelection.planning_mode) ||
            (claudeToolbarVisible && claudeSelection.planning_mode)) &&
            'codex-plan-composer',
          dragActive && 'border-primary/70 bg-primary/5 ring-2 ring-primary/20',
        )}
      >
        {attachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <ImageAttachmentPreview
                key={attachment.id}
                attachment={attachment}
                onRemove={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
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
          className="h-9 min-h-9 resize-none border-transparent bg-transparent px-1 py-1.5 text-base shadow-none focus-visible:ring-0 sm:py-2 sm:text-sm"
        />
        <div className="mt-2 flex min-h-8 items-center gap-1.5">
          {codexToolbarVisible ? (
            <>
              <CodexToolbar
                options={codexOptions}
                selection={codexSelection}
                loading={codexOptionsLoading}
                error={codexOptionsError}
                disabled={codexControlsDisabled}
                onChange={setCodexSelection}
                className="hidden sm:flex"
              />
              <MobileCodexOptions
                options={codexOptions}
                selection={codexSelection}
                loading={codexOptionsLoading}
                error={codexOptionsError}
                disabled={codexControlsDisabled}
                onChange={setCodexSelection}
              />
            </>
          ) : null}
          {claudeToolbarVisible ? (
            <>
              <ClaudeToolbar
                selection={claudeSelection}
                disabled={disabled || submitting}
                onChange={setClaudeSelection}
                className="hidden sm:flex"
              />
              <MobileClaudeOptions
                selection={claudeSelection}
                disabled={disabled || submitting}
                onChange={setClaudeSelection}
              />
            </>
          ) : null}
          <div className="ml-auto flex items-center gap-1.5">
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
              <span className="hidden sm:inline-flex">
                <ToggleControl
                  label="Debug"
                  icon={<Bug className="size-4" aria-hidden="true" />}
                  active={showDebugEvents}
                  disabled={false}
                  iconOnly
                  activeClassName="bg-orange-100 text-orange-800 dark:bg-orange-400/18 dark:text-orange-200"
                  onClick={() => onShowDebugEventsChange(!showDebugEvents)}
                />
              </span>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={inputDisabled}
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach images"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
            >
              <Paperclip />
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!canQueue}
              onClick={() => void enqueueDraft()}
              title={
                queueBlockedByAttachments
                  ? 'Queued messages cannot include image attachments.'
                  : `Queue message (${queueShortcutLabel})`
              }
              aria-label={`Queue message (${queueShortcutLabel})`}
              className="h-8 px-2.5 text-sm"
            >
              <ClipboardList />
              <span className="hidden sm:inline">Queue</span>
            </Button>
            {canCancel ? (
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={cancelling}
                onClick={() => void handleCancel()}
                className="h-8 w-8 border-destructive/40 text-destructive hover:bg-destructive/10"
                aria-label="Cancel running session"
              >
                <Square />
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={!canSubmit}
                aria-label="Submit prompt"
                className="h-8 px-2.5 text-sm"
              >
                <Send />
                <span className="hidden sm:inline">{submitting ? 'Sending' : 'Send'}</span>
              </Button>
            )}
          </div>
        </div>
      </div>
    </form>
  )
}

function ImageAttachmentPreview({ attachment, onRemove }: { attachment: ComposerAttachment; onRemove: () => void }) {
  return (
    <figure className="group relative grid w-24 gap-1 rounded-lg border border-border/80 bg-surface-muted/70 p-1.5 shadow-sm">
      <div className="aspect-square overflow-hidden rounded-md bg-background">
        <img src={attachment.data_url} alt={attachment.name} className="h-full w-full object-cover" />
      </div>
      <figcaption className="min-w-0 truncate px-0.5 text-[10px] text-muted-foreground">{attachment.name}</figcaption>
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

function QueuedMessageRow({
  index,
  message,
  onRemove,
}: {
  index: number
  message: string
  onRemove: () => void
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 py-1.5 text-sm text-muted-foreground',
        index > 0 && 'border-t border-border/55',
      )}
    >
      <span className="pt-0.5 text-xs font-semibold tabular-nums text-muted-foreground/75">{index + 1}</span>
      <p className="min-w-0 flex-1 truncate">{message}</p>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Remove queued message ${index + 1}`}
        onClick={onRemove}
        className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
      >
        <X className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  )
}

function hasDraggedFiles(event: DragEvent<HTMLDivElement>) {
  return Array.from(event.dataTransfer.types).includes('Files')
}

function clipboardImageFiles(data: DataTransfer) {
  const directFiles = Array.from(data.files ?? []).filter((file) => file.type.startsWith('image/'))
  if (directFiles.length > 0) {
    return directFiles
  }

  return Array.from(data.items ?? []).flatMap((item) => {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) {
      return []
    }
    const file = item.getAsFile()
    return file ? [file] : []
  })
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
  className,
}: {
  options: CodexAgentOptions | null
  selection: CodexSelection
  loading: boolean
  error: string
  disabled: boolean
  onChange: (selection: CodexSelection) => void
  className?: string
}) {
  const [openMenu, setOpenMenu] = useState<'model' | 'reasoning' | null>(null)
  const model = selectedModel(options, selection.model)
  const reasoningOptions = model?.supported_reasoning_efforts ?? []
  const fastTier = fastTierForModel(model)
  const planAvailable = Boolean(options?.collaboration_modes.some((mode) => mode.mode === 'plan'))

  if (loading && !options) {
    return <span className={cn('text-xs font-medium text-muted-foreground', className)}>Loading Codex options...</span>
  }

  if (error && !options) {
    return <span className={cn('text-xs font-medium text-destructive', className)}>Codex options unavailable</span>
  }

  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-1.5 pl-1.5 text-sm font-medium text-muted-foreground',
        className,
      )}
    >
      <SlidersHorizontal className="size-4 shrink-0" aria-hidden="true" />
      <OptionMenu
        label="Model"
        value={model?.display_name || selection.model || 'Model'}
        open={openMenu === 'model'}
        onOpenChange={(open) => setOpenMenu(open ? 'model' : null)}
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
        open={openMenu === 'reasoning'}
        onOpenChange={(open) => setOpenMenu(open ? 'reasoning' : null)}
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
      <SwitchControl
        label="Plan"
        active={selection.planning_mode && planAvailable}
        disabled={disabled || !planAvailable}
        onClick={() => onChange({ ...selection, planning_mode: planAvailable ? !selection.planning_mode : false })}
      />
    </div>
  )
}

function MobileCodexOptions({
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
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [openMenu, setOpenMenu] = useState<'model' | 'reasoning' | null>(null)
  const model = selectedModel(options, selection.model)
  const reasoningOptions = model?.supported_reasoning_efforts ?? []
  const fastTier = fastTierForModel(model)
  const planAvailable = Boolean(options?.collaboration_modes.some((mode) => mode.mode === 'plan'))
  const hasActiveMode = (selection.fast_mode && Boolean(fastTier)) || (selection.planning_mode && planAvailable)
  const summary = mobileCodexSummary({
    loading,
    error,
    options,
    modelName: model?.display_name || selection.model,
    reasoningEffort: selection.reasoning_effort || model?.default_reasoning_effort,
  })

  useEffect(() => {
    if (!open) {
      setOpenMenu(null)
      return
    }

    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div ref={menuRef} className="relative sm:hidden">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Composer options"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'h-8 w-8 text-muted-foreground hover:text-foreground',
          hasActiveMode && 'bg-primary/12 text-primary hover:bg-primary/16 hover:text-primary',
        )}
      >
        <SlidersHorizontal aria-hidden="true" />
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label="Composer options"
          className="absolute bottom-full left-0 z-50 mb-2 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-border/80 bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Options</p>
            <p className="min-w-0 truncate text-right text-xs text-muted-foreground">{summary}</p>
          </div>
          {loading && !options ? (
            <p className="text-sm text-muted-foreground">Loading Codex options...</p>
          ) : error && !options ? (
            <p className="text-sm text-destructive">Codex options unavailable</p>
          ) : (
            <div className="space-y-2">
              <OptionMenu
                label="Model"
                value={model?.display_name || selection.model || 'Model'}
                open={openMenu === 'model'}
                onOpenChange={(nextOpen) => setOpenMenu(nextOpen ? 'model' : null)}
                disabled={disabled || !options?.models.length}
                options={(options?.models ?? []).map((item) => ({ value: item.model, label: item.display_name }))}
                onSelect={(modelValue) => {
                  onChange(reconcileCodexSelection({ ...selection, model: modelValue }, options))
                }}
                buttonClassName="w-full justify-between rounded-md border border-border/80 bg-surface-muted/40 px-2"
                valueClassName="max-w-[13rem]"
                menuLayout="inline"
              />
              <OptionMenu
                label="Reasoning"
                value={selection.reasoning_effort || model?.default_reasoning_effort || 'Reasoning'}
                open={openMenu === 'reasoning'}
                onOpenChange={(nextOpen) => setOpenMenu(nextOpen ? 'reasoning' : null)}
                disabled={disabled || reasoningOptions.length === 0}
                options={reasoningOptions.map((item) => ({
                  value: item.reasoning_effort,
                  label: item.reasoning_effort,
                  description: item.description,
                }))}
                onSelect={(reasoningEffort) => onChange({ ...selection, reasoning_effort: reasoningEffort })}
                buttonClassName="w-full justify-between rounded-md border border-border/80 bg-surface-muted/40 px-2"
                valueClassName="max-w-[13rem]"
                menuLayout="inline"
              />
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <ToggleControl
                  label="Fast"
                  icon={<Zap className="size-4" aria-hidden="true" />}
                  active={selection.fast_mode && Boolean(fastTier)}
                  disabled={disabled || !fastTier}
                  onClick={() => onChange({ ...selection, fast_mode: fastTier ? !selection.fast_mode : false })}
                />
                <SwitchControl
                  label="Plan"
                  active={selection.planning_mode && planAvailable}
                  disabled={disabled || !planAvailable}
                  onClick={() =>
                    onChange({ ...selection, planning_mode: planAvailable ? !selection.planning_mode : false })
                  }
                />
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

function mobileCodexSummary({
  loading,
  error,
  options,
  modelName,
  reasoningEffort,
}: {
  loading: boolean
  error: string
  options: CodexAgentOptions | null
  modelName: string
  reasoningEffort: string | undefined
}) {
  if (loading && !options) {
    return 'Loading'
  }
  if (error && !options) {
    return 'Unavailable'
  }
  return [modelName || 'Model', reasoningEffort].filter(Boolean).join(' / ')
}

function ClaudeToolbar({
  selection,
  disabled,
  onChange,
  className,
}: {
  selection: ClaudeSelection
  disabled: boolean
  onChange: (selection: ClaudeSelection) => void
  className?: string
}) {
  const [openMenu, setOpenMenu] = useState<'model' | 'effort' | null>(null)

  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-1.5 pl-1.5 text-sm font-medium text-muted-foreground',
        className,
      )}
    >
      <SlidersHorizontal className="size-4 shrink-0" aria-hidden="true" />
      <OptionMenu
        label="Model"
        value={claudeModelLabel(selection.model)}
        open={openMenu === 'model'}
        onOpenChange={(open) => setOpenMenu(open ? 'model' : null)}
        disabled={disabled}
        options={claudeModelOptions}
        onSelect={(model) => onChange({ ...selection, model })}
      />
      <span aria-hidden="true" className="text-muted-foreground/70">
        ·
      </span>
      <OptionMenu
        label="Effort"
        value={selection.effort || 'Effort'}
        open={openMenu === 'effort'}
        onOpenChange={(open) => setOpenMenu(open ? 'effort' : null)}
        disabled={disabled}
        options={claudeEffortOptions}
        onSelect={(effort) => onChange({ ...selection, effort })}
      />
      <SwitchControl
        label="Plan"
        active={selection.planning_mode}
        disabled={disabled}
        onClick={() => onChange({ ...selection, planning_mode: !selection.planning_mode })}
      />
    </div>
  )
}

function MobileClaudeOptions({
  selection,
  disabled,
  onChange,
}: {
  selection: ClaudeSelection
  disabled: boolean
  onChange: (selection: ClaudeSelection) => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [openMenu, setOpenMenu] = useState<'model' | 'effort' | null>(null)
  const hasActiveMode = selection.planning_mode
  const summary = [claudeModelLabel(selection.model), selection.effort].filter(Boolean).join(' / ')

  useEffect(() => {
    if (!open) {
      setOpenMenu(null)
      return
    }

    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div ref={menuRef} className="relative sm:hidden">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Composer options"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'h-8 w-8 text-muted-foreground hover:text-foreground',
          hasActiveMode && 'bg-primary/12 text-primary hover:bg-primary/16 hover:text-primary',
        )}
      >
        <SlidersHorizontal aria-hidden="true" />
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label="Composer options"
          className="absolute bottom-full left-0 z-50 mb-2 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-border/80 bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Options</p>
            <p className="min-w-0 truncate text-right text-xs text-muted-foreground">{summary}</p>
          </div>
          <div className="space-y-2">
            <OptionMenu
              label="Model"
              value={claudeModelLabel(selection.model)}
              open={openMenu === 'model'}
              onOpenChange={(nextOpen) => setOpenMenu(nextOpen ? 'model' : null)}
              disabled={disabled}
              options={claudeModelOptions}
              onSelect={(model) => onChange({ ...selection, model })}
              buttonClassName="w-full justify-between rounded-md border border-border/80 bg-surface-muted/40 px-2"
              valueClassName="max-w-[13rem]"
              menuLayout="inline"
            />
            <OptionMenu
              label="Effort"
              value={selection.effort || 'Effort'}
              open={openMenu === 'effort'}
              onOpenChange={(nextOpen) => setOpenMenu(nextOpen ? 'effort' : null)}
              disabled={disabled}
              options={claudeEffortOptions}
              onSelect={(effort) => onChange({ ...selection, effort })}
              buttonClassName="w-full justify-between rounded-md border border-border/80 bg-surface-muted/40 px-2"
              valueClassName="max-w-[13rem]"
              menuLayout="inline"
            />
            <div className="pt-1">
              <SwitchControl
                label="Plan"
                active={selection.planning_mode}
                disabled={disabled}
                onClick={() => onChange({ ...selection, planning_mode: !selection.planning_mode })}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function claudeModelLabel(model: string) {
  return claudeModelOptions.find((option) => option.value === model)?.label ?? (model || 'Default')
}

function OptionMenu({
  label,
  value,
  open,
  onOpenChange,
  options,
  disabled,
  onSelect,
  buttonClassName,
  valueClassName,
  menuLayout = 'floating',
}: {
  label: string
  value: string
  open: boolean
  onOpenChange: (open: boolean) => void
  options: { value: string; label: string; description?: string }[]
  disabled: boolean
  onSelect: (value: string) => void
  buttonClassName?: string
  valueClassName?: string
  menuLayout?: 'floating' | 'inline'
}) {
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
        className={cn(
          'inline-flex h-8 items-center gap-1 rounded-md px-1.5 text-sm font-semibold text-foreground/78 transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
          buttonClassName,
        )}
      >
        <span className={cn('max-w-40 truncate', valueClassName)}>{value}</span>
        <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label={label}
          className={cn(
            'z-50 overflow-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-border/70',
            menuLayout === 'inline'
              ? 'mt-1 max-h-52 w-full'
              : 'absolute bottom-full left-0 mb-2 max-h-72 min-w-48',
          )}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.label === value}
              onClick={() => {
                onSelect(option.value)
                onOpenChange(false)
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

function SwitchControl({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string
  active: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={active}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 items-center gap-2 rounded-full px-2 text-sm font-semibold text-foreground/72 transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      <ClipboardList className="size-4" aria-hidden="true" />
      <span>{label}</span>
      <span
        className={cn(
          'relative inline-flex h-4 w-7 shrink-0 rounded-full border transition-colors',
          active ? 'border-amber-500/50 bg-amber-400 dark:bg-amber-400/70' : 'border-border/80 bg-surface-muted',
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            'absolute top-1/2 size-3 -translate-y-1/2 rounded-full bg-background shadow-sm transition-transform',
            active ? 'translate-x-3.5' : 'translate-x-0.5',
          )}
        />
      </span>
    </button>
  )
}

function submitOptionsForCodex(selection: CodexSelection, fastTier: CodexServiceTierOption | null): SubmitAgentOptions {
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

function submitOptionsForClaude(selection: ClaudeSelection): SubmitAgentOptions {
  return {
    claude: {
      model: selection.model || undefined,
      effort: selection.effort || undefined,
      planning_mode: selection.planning_mode,
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

function loadClaudeSelection(sessionID: string | undefined): ClaudeSelection {
  const stored = loadComposerStorage(sessionID).claudeSelection ?? {}
  return {
    model: typeof stored.model === 'string' ? stored.model : '',
    effort: typeof stored.effort === 'string' ? stored.effort : 'medium',
    planning_mode: Boolean(stored.planning_mode),
  }
}

function saveClaudeSelection(sessionID: string | undefined, selection: ClaudeSelection) {
  saveComposerStorage(sessionID, {
    ...loadComposerStorage(sessionID),
    claudeSelection: selection,
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

function insertTextareaNewline(textarea: HTMLTextAreaElement, setContent: (content: string) => void) {
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
