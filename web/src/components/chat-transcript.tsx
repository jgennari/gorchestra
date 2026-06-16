import { Brain, Check, ChevronDown, ChevronRight, ChevronUp, ClipboardList, Copy, FileText, Loader2 } from 'lucide-react'
import {
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentEvent } from '@/lib/api'
import type {
  ChatActionBreak,
  ChatDebugEvent,
  ChatRunError,
  ChatTimelineItem,
  ChatTranscriptAttachment,
  ChatTranscriptMessage,
  ChatTranscriptTool,
} from '@/lib/events'
import { buildChatTimeline } from '@/lib/events'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 48
const scrollIntentKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

type Props = {
  events: AgentEvent[]
  loading?: boolean
  error?: string
  topInset?: 'none' | 'sessionHeader' | 'sessionHeaderAlert'
  bottomInsetHeight?: number
  thinking?: boolean
  showDebugEvents?: boolean
  hasOlderEvents?: boolean
  loadingOlderEvents?: boolean
  onLoadOlderEvents?: () => Promise<void> | void
  onOpenFilePath?: (path: string) => Promise<void> | void
}

export function ChatTranscript({
  events,
  loading = false,
  error = '',
  topInset = 'none',
  bottomInsetHeight = 176,
  thinking = false,
  showDebugEvents = false,
  hasOlderEvents = false,
  loadingOlderEvents = false,
  onLoadOlderEvents,
  onOpenFilePath,
}: Props) {
  const timeline = useMemo(() => buildChatTimeline(events, showDebugEvents), [events, showDebugEvents])
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollIdleTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const autoLoadOlderRef = useRef(false)
  const autoScrollPausedRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  const userScrollIntentRef = useRef(false)
  const [scrolling, setScrolling] = useState(false)
  const [autoScrollPaused, setAutoScrollPaused] = useState(false)
  const lastSeq = timeline.at(-1)?.endSeq ?? 0
  const bottomAnchorKey = `${lastSeq}:${thinking ? 'thinking' : 'idle'}`

  function setAutoScrollPausedState(paused: boolean) {
    autoScrollPausedRef.current = paused
    setAutoScrollPaused((current) => (current === paused ? current : paused))
  }

  function scrollToBottom(element: HTMLDivElement) {
    element.scrollTop = element.scrollHeight
    lastScrollTopRef.current = element.scrollTop
  }

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }
    if (!autoScrollPausedRef.current) {
      scrollToBottom(element)
    }
  }, [bottomAnchorKey])

  useEffect(() => {
    if (events.length === 0) {
      setAutoScrollPausedState(false)
    }
  }, [events.length])

  useEffect(() => {
    if (!loadingOlderEvents) {
      autoLoadOlderRef.current = false
    }
  }, [loadingOlderEvents])

  useEffect(() => {
    return () => {
      if (scrollIdleTimer.current) {
        window.clearTimeout(scrollIdleTimer.current)
      }
    }
  }, [])

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    setScrolling(true)
    if (scrollIdleTimer.current) {
      window.clearTimeout(scrollIdleTimer.current)
    }
    scrollIdleTimer.current = window.setTimeout(() => setScrolling(false), 900)
    const nearBottom = isScrolledNearBottom(event.currentTarget)
    const scrolledUp = event.currentTarget.scrollTop < lastScrollTopRef.current - 1
    if (nearBottom) {
      userScrollIntentRef.current = false
      setAutoScrollPausedState(false)
    } else if (scrolledUp || userScrollIntentRef.current || autoScrollPausedRef.current) {
      setAutoScrollPausedState(true)
    }
    lastScrollTopRef.current = event.currentTarget.scrollTop
    maybeLoadOlderFromScroll(event.currentTarget)
  }

  function markUserScrollIntent() {
    userScrollIntentRef.current = true
  }

  function handleScrollKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (scrollIntentKeys.has(event.key)) {
      markUserScrollIntent()
    }
  }

  function resumeAutoScroll() {
    const element = scrollRef.current
    if (!element) {
      return
    }
    setAutoScrollPausedState(false)
    scrollToBottom(element)
  }

  function maybeLoadOlderFromScroll(element: HTMLDivElement) {
    if (
      element.scrollTop > 0 ||
      !hasOlderEvents ||
      loadingOlderEvents ||
      autoLoadOlderRef.current ||
      !onLoadOlderEvents
    ) {
      return
    }

    autoLoadOlderRef.current = true
    void Promise.resolve()
      .then(() => onLoadOlderEvents())
      .finally(() => {
        autoLoadOlderRef.current = false
      })
  }

  if (error && timeline.length === 0) {
    return (
      <div role="alert" className="flex h-full items-center justify-center p-8 text-center text-sm text-destructive">
        Failed to load chat history: {error}
      </div>
    )
  }

  if (loading && timeline.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        Loading chat history...
      </div>
    )
  }

  if (timeline.length === 0 && !thinking) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        No messages yet. Submit a prompt to start the chat.
      </div>
    )
  }

  const latestMessageIndex = timeline.reduce((latest, item, index) => (item.kind === 'message' ? index : latest), -1)
  const contentBottomPadding = Math.max(64, bottomInsetHeight + 16)
  const jumpButtonBottom = Math.max(16, bottomInsetHeight + 12)

  return (
    <div className="chat-canvas relative h-full min-h-0 overflow-hidden">
      <ScrollArea
        ref={scrollRef}
        className="chat-scroll-area h-full min-h-0"
        data-scrolling={scrolling ? 'true' : undefined}
        onScroll={handleScroll}
        onWheel={markUserScrollIntent}
        onTouchMove={markUserScrollIntent}
        onKeyDown={handleScrollKeyDown}
        role="log"
        aria-label="Chat messages"
        aria-live="polite"
        aria-relevant="additions text"
      >
        <div
          className={cn(
            'p-4',
            topInset === 'sessionHeader' && 'lg:pt-24',
            topInset === 'sessionHeaderAlert' && 'lg:pt-36',
          )}
          style={{ paddingBottom: `${contentBottomPadding}px` }}
        >
          {hasOlderEvents || loadingOlderEvents ? (
            <LoadOlderEventsButton loading={loadingOlderEvents} onLoad={onLoadOlderEvents} />
          ) : null}
          {timeline.map((item, index) => (
            <div
              key={item.id}
              className={timelineRowSpacing(item, timeline[index - 1], index > 0 || hasOlderEvents || loadingOlderEvents)}
            >
              <ChatTimelineRow
                item={item}
                collapseExtraTools={item.kind === 'message' && index < latestMessageIndex}
                onOpenFilePath={onOpenFilePath}
              />
            </div>
          ))}
          {thinking ? (
            <div className={timeline.length > 0 || hasOlderEvents || loadingOlderEvents ? 'mt-5' : ''}>
              <ThinkingIndicatorRow />
            </div>
          ) : null}
        </div>
      </ScrollArea>
      {autoScrollPaused ? (
        <div
          className={cn(
            'pointer-events-none absolute inset-x-0 z-20 flex justify-center px-4',
          )}
          style={{ bottom: `${jumpButtonBottom}px` }}
        >
          <button
            type="button"
            className="pointer-events-auto inline-flex h-9 items-center gap-2 rounded-full border border-border/70 bg-background/90 px-3.5 text-xs font-medium text-foreground shadow-lg shadow-black/10 backdrop-blur transition-colors hover:bg-background"
            aria-label="Scroll to latest and resume auto-scroll"
            onClick={resumeAutoScroll}
          >
            <ChevronDown className="size-3.5" aria-hidden="true" />
            Jump to latest
          </button>
        </div>
      ) : null}
    </div>
  )
}

function ThinkingIndicatorRow() {
  const gradientId = `thinking-gradient-${useId().replace(/:/g, '')}`

  return (
    <article className="flex justify-start">
      <div
        role="status"
        aria-label="Thinking"
        aria-live="polite"
        className="thinking-indicator inline-flex max-w-[min(48rem,90%)] items-center gap-2 px-1 py-1 text-sm font-medium"
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
    </article>
  )
}

function isScrolledNearBottom(element: HTMLDivElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX
}

function timelineRowSpacing(item: ChatTimelineItem, previous: ChatTimelineItem | undefined, hasPriorRow: boolean) {
  if (!hasPriorRow) {
    return ''
  }
  if (item.kind === 'debug' && previous?.kind === 'debug') {
    return 'mt-1'
  }
  if (item.kind === 'error' && previous?.kind === 'error') {
    return 'mt-2'
  }
  if (item.kind === 'debug' || previous?.kind === 'debug') {
    return 'mt-2'
  }
  if (item.kind === 'error' || previous?.kind === 'error') {
    return 'mt-3'
  }
  return 'mt-5'
}

function LoadOlderEventsButton({ loading, onLoad }: { loading: boolean; onLoad?: () => Promise<void> | void }) {
  return (
    <div className="flex justify-center">
      <button
        type="button"
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-background/80 px-3 text-xs font-medium text-muted-foreground shadow-sm transition-colors hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
        aria-label="Load older events"
        disabled={loading || !onLoad}
        onClick={() => void onLoad?.()}
      >
        {loading ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <ChevronUp className="size-3.5" aria-hidden="true" />
        )}
        {loading ? 'Loading' : 'Load older'}
      </button>
    </div>
  )
}

function ChatTimelineRow({
  item,
  collapseExtraTools,
  onOpenFilePath,
}: {
  item: ChatTimelineItem
  collapseExtraTools: boolean
  onOpenFilePath?: (path: string) => Promise<void> | void
}) {
  if (item.kind === 'action') {
    return <ActionBreakRow action={item.action} />
  }
  if (item.kind === 'debug') {
    return <DebugEventRow event={item.event} />
  }
  if (item.kind === 'error') {
    return <RunErrorRow error={item.error} />
  }
  return (
    <ChatMessageRow
      message={item.message}
      collapseExtraTools={collapseExtraTools}
      onOpenFilePath={onOpenFilePath}
    />
  )
}

function ActionBreakRow({ action }: { action: ChatActionBreak }) {
  return (
    <div
      className="flex items-center gap-3 py-1"
      role="separator"
      aria-label={action.label}
    >
      <div className="h-px flex-1 bg-border/70" aria-hidden="true" />
      <span className="rounded-full border border-border/70 bg-background/85 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground shadow-sm">
        {action.label}
      </span>
      <div className="h-px flex-1 bg-border/70" aria-hidden="true" />
    </div>
  )
}

function ChatMessageRow({
  message,
  collapseExtraTools,
  onOpenFilePath,
}: {
  message: ChatTranscriptMessage
  collapseExtraTools: boolean
  onOpenFilePath?: (path: string) => Promise<void> | void
}) {
  const user = message.role === 'user'
  const plan = message.variant === 'plan'
  const [showAllTools, setShowAllTools] = useState(false)
  const shouldCollapseTools = collapseExtraTools && message.tools.length > 3
  const visibleTools = !shouldCollapseTools || showAllTools ? message.tools : message.tools.slice(0, 3)
  const hasHiddenTools = message.tools.length > visibleTools.length
  const timestamp = formatMessageTimestamp(message.createdAt)

  return (
    <article className={cn('flex', user ? 'justify-end' : 'justify-start')} data-message-variant={message.variant}>
      <div className="max-w-[min(48rem,90%)]">
        <div
          className={cn(
            'rounded-lg px-3.5 py-3 text-sm shadow-sm',
            user
              ? 'border border-primary/30 bg-primary text-primary-foreground shadow-[0_12px_30px_hsl(var(--primary)/0.16)]'
              : plan
                ? 'border border-l-4 border-amber-300/75 border-l-amber-400 bg-amber-50/85 text-amber-950 shadow-[0_12px_30px_hsl(43_96%_56%/0.12)] dark:border-amber-400/35 dark:border-l-amber-300 dark:bg-amber-400/10 dark:text-amber-100'
                : 'command-card border text-card-foreground',
          )}
        >
          <div
            className={cn(
              'mb-1 flex items-center justify-between gap-4 text-xs font-medium',
              user
                ? 'text-primary-foreground/80'
                : plan
                  ? 'text-amber-800 dark:text-amber-200'
                  : 'text-muted-foreground',
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              {plan ? <ClipboardList className="size-3.5 shrink-0" aria-hidden="true" /> : null}
              <span>{message.label}</span>
            </span>
            {timestamp ? (
              <time className="shrink-0 text-right font-normal tabular-nums" dateTime={message.createdAt}>
                {timestamp}
              </time>
            ) : null}
          </div>

          {message.attachments.length > 0 ? <MessageAttachments attachments={message.attachments} /> : null}

          {message.text ? (
            <MarkdownContent
              content={message.text}
              variant={user ? 'inverted' : plan ? 'plan' : 'default'}
              onOpenFilePath={onOpenFilePath}
            />
          ) : user && message.attachments.length > 0 ? null : (
            <p className="text-muted-foreground">Working...</p>
          )}
        </div>

        {message.tools.length > 0 ? (
          <div
            className={cn(
              'mt-2 space-y-1 border-l pl-3',
              plan ? 'border-amber-300/70 dark:border-amber-400/35' : 'border-border/80',
            )}
          >
            {visibleTools.map((tool) => (
              <ToolCallRow key={tool.id} tool={tool} onOpenFilePath={onOpenFilePath} />
            ))}
            {shouldCollapseTools ? (
              <button
                type="button"
                className="inline-flex items-center gap-0.5 rounded py-0 text-[10px] font-normal leading-none text-muted-foreground/65 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={showAllTools}
                onClick={() => setShowAllTools((current) => !current)}
              >
                {hasHiddenTools ? (
                  <ChevronRight className="size-2.5" aria-hidden="true" />
                ) : (
                  <ChevronDown className="size-2.5" aria-hidden="true" />
                )}
                {hasHiddenTools ? `Show ${message.tools.length - visibleTools.length} More` : 'Show Less'}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  )
}

function MessageAttachments({ attachments }: { attachments: ChatTranscriptAttachment[] }) {
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {attachments.map((attachment, index) => (
        <a
          key={`${attachment.name}-${index}`}
          href={attachment.dataURL}
          target="_blank"
          rel="noreferrer"
          className="block overflow-hidden rounded-md border border-border/70 bg-background/80"
          aria-label={`Open ${attachment.name}`}
        >
          <img src={attachment.dataURL} alt={attachment.name} className="h-24 w-24 object-cover" />
        </a>
      ))}
    </div>
  )
}

function formatMessageTimestamp(value: string) {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date)
}

type MarkdownVariant = 'default' | 'inverted' | 'plan'

function MarkdownContent({
  content,
  variant,
  onOpenFilePath,
}: {
  content: string
  variant: MarkdownVariant
  onOpenFilePath?: (path: string) => Promise<void> | void
}) {
  const inverted = variant === 'inverted'
  const plan = variant === 'plan'

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => (
          <p className="my-2 first:mt-0 last:mb-0 whitespace-pre-wrap break-words leading-relaxed">{children}</p>
        ),
        a: ({ children, href }) => {
          const filePath = markdownFilePathFromHref(href)
          const opensFileEditor = Boolean(filePath && onOpenFilePath)

          return (
            <a
              href={href}
              target={opensFileEditor ? undefined : '_blank'}
              rel={opensFileEditor ? undefined : 'noreferrer'}
              className={cn(
                'underline underline-offset-2',
                inverted ? 'text-primary-foreground' : plan ? 'text-amber-700 dark:text-amber-200' : 'text-primary',
              )}
              onClick={
                opensFileEditor
                  ? (event) => {
                      event.preventDefault()
                      void onOpenFilePath?.(filePath)
                    }
                  : undefined
              }
            >
              {children}
            </a>
          )
        },
        ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote
            className={cn(
              'my-2 border-l-2 pl-3 italic',
              inverted
                ? 'border-primary-foreground/50'
                : plan
                  ? 'border-amber-400/70 text-amber-900/80 dark:border-amber-300/50 dark:text-amber-100/80'
                  : 'border-border text-muted-foreground',
            )}
          >
            {children}
          </blockquote>
        ),
        code: ({ children, className }) => {
          const code = childrenToString(children)
          const block = className?.startsWith('language-') || code.endsWith('\n')
          if (block) {
            return (
              <CodeBlock code={code} className={className} variant={variant}>
                {children}
              </CodeBlock>
            )
          }
          return (
            <code
              className={cn(
                'rounded border px-1 py-0.5 font-mono text-[0.85em]',
                inverted
                  ? 'border-primary-foreground/20 bg-primary-foreground/15'
                  : plan
                    ? 'border-amber-300/70 bg-amber-100/85 text-amber-950 dark:border-amber-300/35 dark:bg-amber-300/14 dark:text-amber-50'
                    : 'border-transparent bg-muted',
              )}
            >
              {children}
            </code>
          )
        },
        pre: ({ children }) => <>{children}</>,
        h1: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h3>,
        h2: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h3>,
        h3: ({ children }) => <h3 className="mb-2 mt-3 text-sm font-semibold first:mt-0">{children}</h3>,
        hr: () => (
          <hr
            className={cn(
              'my-3 border-t',
              inverted ? 'border-primary-foreground/30' : plan ? 'border-amber-300/70' : 'border-border',
            )}
          />
        ),
        table: ({ children }) => (
          <div className="my-2 overflow-auto">
            <table className="w-full border-collapse text-xs">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className="border px-2 py-1 text-left font-medium">{children}</th>,
        td: ({ children }) => <td className="border px-2 py-1 align-top">{children}</td>,
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

function markdownFilePathFromHref(href: string | undefined) {
  let value = href?.trim() ?? ''
  if (!value || value.startsWith('#')) {
    return ''
  }

  if (value.startsWith('file://')) {
    value = value.slice('file://'.length)
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    try {
      const url = new URL(value)
      if (url.origin !== window.location.origin) {
        return ''
      }
      value = `${url.pathname}${url.search}${url.hash}`
    } catch {
      return ''
    }
  }

  try {
    value = decodeURI(value)
  } catch {
    // Keep the original href if it is not valid URI-encoded text.
  }

  value = value.split('#')[0]?.split('?')[0]?.replaceAll('\\', '/').replace(/:\d+(?::\d+)?$/, '') ?? ''
  if (!value || value.endsWith('/')) {
    return ''
  }

  return looksLikeWorkspaceFileLink(value) ? value : ''
}

function looksLikeWorkspaceFileLink(path: string) {
  if (path.startsWith('./') || path.startsWith('../')) {
    return true
  }
  if (path.startsWith('/')) {
    return (
      ['/Users/', '/home/', '/repo/', '/workspace/', '/workspaces/', '/private/', '/tmp/', '/var/'].some((prefix) =>
        path.startsWith(prefix),
      ) && looksLikeFileName(path)
    )
  }
  return looksLikeFileName(path)
}

function looksLikeFileName(path: string) {
  const name = path.split('/').at(-1) ?? ''
  return (
    /^(AGENTS\.md|README(?:\.[\w-]+)?|Makefile|Dockerfile|go\.mod|go\.sum|package\.json|pnpm-lock\.yaml|yarn\.lock|\.env(?:\.[\w-]+)?)$/i.test(
      name,
    ) || /\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(name)
  )
}

function CodeBlock({
  code,
  className,
  variant,
  children,
}: {
  code: string
  className?: string
  variant: MarkdownVariant
  children: ReactNode
}) {
  return (
    <div className="group/code relative my-2">
      <FloatingCopyButton label="Copy code" value={code} variant={variant} />
      <pre className="overflow-auto rounded-md">
        <code
          className={cn(
            'block min-w-full whitespace-pre border p-3 pr-12 font-mono text-xs',
            variant === 'inverted'
              ? 'border-primary-foreground/20 bg-primary-foreground/15'
              : variant === 'plan'
                ? 'border-amber-300/70 bg-amber-100/80 text-amber-950 dark:border-amber-300/35 dark:bg-amber-300/12 dark:text-amber-50'
                : 'border-transparent bg-muted',
            className,
          )}
        >
          {children}
        </code>
      </pre>
    </div>
  )
}

function FloatingCopyButton({
  label,
  value,
  variant = 'default',
}: {
  label: string
  value: string
  variant?: MarkdownVariant
}) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => void handleCopy()}
      className={cn(
        'absolute right-4 top-2 z-10 inline-flex size-7 items-center justify-center rounded-md border text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        variant === 'inverted'
          ? 'border-primary-foreground/20 bg-primary-foreground/12 text-primary-foreground hover:bg-primary-foreground/20'
          : variant === 'plan'
            ? 'border-amber-300/70 bg-amber-50/95 text-amber-800 hover:bg-amber-100 dark:border-amber-300/35 dark:bg-amber-950/80 dark:text-amber-100 dark:hover:bg-amber-900'
            : 'border-border/70 bg-background/90 text-muted-foreground hover:bg-background hover:text-foreground',
      )}
    >
      {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
    </button>
  )
}

function childrenToString(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children)
  }
  if (Array.isArray(children)) {
    return children.map(childrenToString).join('')
  }
  if (isValidElement<{ children?: ReactNode }>(children)) {
    return childrenToString(children.props.children)
  }
  return ''
}

function ToolCallRow({
  tool,
  onOpenFilePath,
}: {
  tool: ChatTranscriptTool
  onOpenFilePath?: (path: string) => Promise<void> | void
}) {
  const output = tool.error || tool.text
  const [outputOpen, setOutputOpen] = useState(false)
  const name = tool.label.replace(/^Tool:\s*/, '')
  const statusDotClassName = toolStatusDotClassName(tool)
  const filePath = tool.kind === 'file-change' ? (tool.paths[0] ?? '') : ''
  const showFileEditorAction = Boolean(onOpenFilePath && filePath && output && !tool.error && looksLikeDiff(output))

  return (
    <div className="text-xs">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1 rounded py-0.5 text-left font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={output ? outputOpen : undefined}
        aria-label={`${outputOpen ? 'Collapse' : 'Expand'} ${name}`}
        onClick={() => {
          if (output) {
            setOutputOpen((current) => !current)
          }
        }}
      >
        {outputOpen ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        {statusDotClassName ? (
          <span className={cn('mr-0.5 size-2 shrink-0 rounded-full', statusDotClassName)} aria-hidden="true" />
        ) : null}
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
      </button>
      {output ? (
        outputOpen ? (
          <div className="relative ml-5 mt-1">
            <FloatingCopyButton label="Copy tool output" value={output} />
            {showFileEditorAction ? <FloatingOpenFileButton path={filePath} onOpenFilePath={onOpenFilePath} /> : null}
            <ToolOutput
              output={output}
              error={Boolean(tool.error)}
              diff={tool.kind === 'file-change'}
              actionPadding={showFileEditorAction}
            />
          </div>
        ) : null
      ) : null}
    </div>
  )
}

function FloatingOpenFileButton({
  path,
  onOpenFilePath,
}: {
  path: string
  onOpenFilePath?: (path: string) => Promise<void> | void
}) {
  return (
    <button
      type="button"
      aria-label="Show in File Editor"
      onClick={() => void onOpenFilePath?.(path)}
      className="absolute right-10 top-2 z-10 inline-flex size-7 items-center justify-center rounded-md border border-border/70 bg-background/90 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <FileText className="size-3.5" aria-hidden="true" />
    </button>
  )
}

function ToolOutput({
  output,
  error,
  diff,
  actionPadding = false,
}: {
  output: string
  error: boolean
  diff: boolean
  actionPadding?: boolean
}) {
  if (!diff || error || !looksLikeDiff(output)) {
    return (
      <pre
        className={cn(
          'max-h-44 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-surface-muted/70 p-2 font-mono leading-relaxed text-muted-foreground',
          actionPadding ? 'pr-20' : 'pr-12',
          error && 'text-destructive',
        )}
      >
        {output}
      </pre>
    )
  }

  return (
    <pre
      className={cn(
        'max-h-64 overflow-auto rounded border border-border/60 bg-surface-muted/70 p-2 font-mono leading-relaxed text-muted-foreground',
        actionPadding ? 'pr-20' : 'pr-12',
      )}
    >
      {output.split('\n').map((line, index) => (
        <span
          key={`${index}-${line}`}
          className={cn('block min-h-[1.25em] min-w-full w-max whitespace-pre', diffLineClassName(line))}
        >
          {line || ' '}
        </span>
      ))}
    </pre>
  )
}

function looksLikeDiff(output: string) {
  return output
    .split('\n')
    .some(
      (line) =>
        line.startsWith('@@') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('-') ||
        line.startsWith('+'),
    )
}

function diffLineClassName(line: string) {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return 'bg-destructive/10 text-destructive'
  }
  if (line.startsWith('@@')) {
    return 'bg-primary/10 text-primary'
  }
  return ''
}

function DebugEventRow({ event }: { event: ChatDebugEvent }) {
  const [open, setOpen] = useState(false)
  const sequence = event.startSeq === event.endSeq ? `#${event.startSeq}` : `#${event.startSeq}-${event.endSeq}`
  const payload = JSON.stringify(event.payload, null, 2)

  return (
    <article className="flex justify-start">
      <div className="max-w-[min(48rem,90%)] border-l border-border/70 pl-3 text-xs">
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-1 rounded py-0.5 text-left font-mono text-muted-foreground/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${event.label}`}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">{event.label}</span>
          <span className="shrink-0 text-[11px] capitalize text-muted-foreground/70">{event.status}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/55">{sequence}</span>
          {event.eventCount > 1 ? (
            <span className="shrink-0 text-[11px] text-muted-foreground/55">{event.eventCount} events</span>
          ) : null}
        </button>
        {event.text || event.error ? (
          <p
            className={cn(
              'ml-5 mt-0.5 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground/70',
              event.error && 'text-destructive/85',
            )}
          >
            {event.error || event.text}
          </p>
        ) : null}
        {open ? (
          <div className="relative ml-5 mt-1">
            <FloatingCopyButton label="Copy debug payload" value={payload} />
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-surface-muted/70 p-2 pr-12 font-mono leading-relaxed text-muted-foreground">
              {payload}
            </pre>
          </div>
        ) : null}
      </div>
    </article>
  )
}

function RunErrorRow({ error }: { error: ChatRunError }) {
  const sequence = error.startSeq === error.endSeq ? `#${error.startSeq}` : `#${error.startSeq}-${error.endSeq}`
  const timestamp = formatMessageTimestamp(error.createdAt)

  return (
    <article className="flex justify-start" role="alert" aria-label={`${error.label}: ${error.error}`}>
      <div className="relative max-w-[min(48rem,90%)] rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 pr-12 text-sm text-destructive shadow-sm">
        <FloatingCopyButton label="Copy error" value={error.error} />
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
          <span className="min-w-0 flex-1 truncate">{error.label}</span>
          <span className="shrink-0 text-[11px] capitalize text-destructive/75">{error.status}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-destructive/65">{sequence}</span>
          {timestamp ? (
            <time
              className="shrink-0 text-[11px] font-normal tabular-nums text-destructive/65"
              dateTime={error.createdAt}
            >
              {timestamp}
            </time>
          ) : null}
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-destructive">
          {error.error}
        </p>
      </div>
    </article>
  )
}

function toolStatusDotClassName(tool: ChatTranscriptTool) {
  if (tool.error || tool.status === 'failed') return 'bg-destructive'
  if (tool.status !== 'completed') return 'animate-pulse bg-muted-foreground/45'
  return ''
}
