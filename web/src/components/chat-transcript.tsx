import { Check, ChevronDown, ChevronRight, ChevronUp, Copy, FileText, Loader2 } from 'lucide-react'
import { isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentEvent } from '@/lib/api'
import type {
  ChatDebugEvent,
  ChatTimelineItem,
  ChatTranscriptAttachment,
  ChatTranscriptMessage,
  ChatTranscriptTool,
} from '@/lib/events'
import { buildChatTimeline } from '@/lib/events'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

type Props = {
  events: AgentEvent[]
  loading?: boolean
  error?: string
  topInset?: 'none' | 'sessionHeader'
  bottomInset?: 'composer' | 'question'
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
  bottomInset = 'composer',
  showDebugEvents = false,
  hasOlderEvents = false,
  loadingOlderEvents = false,
  onLoadOlderEvents,
  onOpenFilePath,
}: Props) {
  const timeline = useMemo(() => buildChatTimeline(events, showDebugEvents), [events, showDebugEvents])
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollIdleTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const [scrolling, setScrolling] = useState(false)
  const lastSeq = timeline.at(-1)?.endSeq ?? 0

  useEffect(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }
    element.scrollTop = element.scrollHeight
  }, [lastSeq])

  useEffect(() => {
    return () => {
      if (scrollIdleTimer.current) {
        window.clearTimeout(scrollIdleTimer.current)
      }
    }
  }, [])

  function handleScroll() {
    setScrolling(true)
    if (scrollIdleTimer.current) {
      window.clearTimeout(scrollIdleTimer.current)
    }
    scrollIdleTimer.current = window.setTimeout(() => setScrolling(false), 900)
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

  if (timeline.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        No messages yet. Submit a prompt to start the chat.
      </div>
    )
  }

  return (
    <div className="chat-canvas relative h-full min-h-0 overflow-hidden">
      <ScrollArea
        ref={scrollRef}
        className="chat-scroll-area h-full min-h-0"
        data-scrolling={scrolling ? 'true' : undefined}
        onScroll={handleScroll}
        role="log"
        aria-label="Chat messages"
        aria-live="polite"
        aria-relevant="additions text"
      >
        <div
          className={cn(
            'space-y-5 p-4',
            topInset === 'sessionHeader' && 'pt-24',
            bottomInset === 'question' ? 'pb-80' : 'pb-44',
          )}
        >
          {hasOlderEvents || loadingOlderEvents ? (
            <LoadOlderEventsButton loading={loadingOlderEvents} onLoad={onLoadOlderEvents} />
          ) : null}
          {timeline.map((item) => (
            <ChatTimelineRow key={item.id} item={item} onOpenFilePath={onOpenFilePath} />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function LoadOlderEventsButton({
  loading,
  onLoad,
}: {
  loading: boolean
  onLoad?: () => Promise<void> | void
}) {
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
  onOpenFilePath,
}: {
  item: ChatTimelineItem
  onOpenFilePath?: (path: string) => Promise<void> | void
}) {
  if (item.kind === 'debug') {
    return <DebugEventRow event={item.event} />
  }
  return <ChatMessageRow message={item.message} onOpenFilePath={onOpenFilePath} />
}

function ChatMessageRow({
  message,
  onOpenFilePath,
}: {
  message: ChatTranscriptMessage
  onOpenFilePath?: (path: string) => Promise<void> | void
}) {
  const user = message.role === 'user'
  const [showAllTools, setShowAllTools] = useState(false)
  const visibleTools = showAllTools ? message.tools : message.tools.slice(0, 3)
  const hasHiddenTools = message.tools.length > visibleTools.length
  const timestamp = formatMessageTimestamp(message.createdAt)

  return (
    <article className={cn('flex', user ? 'justify-end' : 'justify-start')}>
      <div className="max-w-[min(48rem,90%)]">
        <div
          className={cn(
            'rounded-lg px-3.5 py-3 text-sm shadow-sm',
            user
              ? 'border border-primary/30 bg-primary text-primary-foreground shadow-[0_12px_30px_hsl(var(--primary)/0.16)]'
              : 'command-card border text-card-foreground',
          )}
        >
          <div
            className={cn(
              'mb-1 flex items-center justify-between gap-4 text-xs font-medium',
              user ? 'text-primary-foreground/80' : 'text-muted-foreground',
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
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
            <MarkdownContent content={message.text} inverted={user} />
          ) : user && message.attachments.length > 0 ? null : (
            <p className="text-muted-foreground">Working...</p>
          )}
        </div>

        {message.tools.length > 0 ? (
          <div className="mt-2 space-y-1 border-l border-border/80 pl-3">
            {visibleTools.map((tool) => (
              <ToolCallRow key={tool.id} tool={tool} onOpenFilePath={onOpenFilePath} />
            ))}
            {message.tools.length > 3 ? (
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

function MarkdownContent({ content, inverted }: { content: string; inverted: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => (
          <p className="my-2 first:mt-0 last:mb-0 whitespace-pre-wrap break-words leading-relaxed">{children}</p>
        ),
        a: ({ children, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className={cn('underline underline-offset-2', inverted ? 'text-primary-foreground' : 'text-primary')}
          >
            {children}
          </a>
        ),
        ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote
            className={cn(
              'my-2 border-l-2 pl-3 italic',
              inverted ? 'border-primary-foreground/50' : 'border-border text-muted-foreground',
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
              <CodeBlock code={code} className={className} inverted={inverted}>
                {children}
              </CodeBlock>
            )
          }
          return (
            <code
              className={cn(
                'rounded px-1 py-0.5 font-mono text-[0.85em]',
                inverted ? 'bg-primary-foreground/15' : 'bg-muted',
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
        hr: () => <hr className={cn('my-3 border-t', inverted ? 'border-primary-foreground/30' : 'border-border')} />,
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

function CodeBlock({
  code,
  className,
  inverted,
  children,
}: {
  code: string
  className?: string
  inverted: boolean
  children: ReactNode
}) {
  return (
    <div className="group/code relative my-2">
      <FloatingCopyButton label="Copy code" value={code} inverted={inverted} />
      <pre className="overflow-auto rounded-md">
        <code
          className={cn(
            'block min-w-full whitespace-pre p-3 pr-12 font-mono text-xs',
            inverted ? 'bg-primary-foreground/15' : 'bg-muted',
            className,
          )}
        >
          {children}
        </code>
      </pre>
    </div>
  )
}

function FloatingCopyButton({ label, value, inverted = false }: { label: string; value: string; inverted?: boolean }) {
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
        'absolute right-2 top-2 z-10 inline-flex size-7 items-center justify-center rounded-md border text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        inverted
          ? 'border-primary-foreground/20 bg-primary-foreground/12 text-primary-foreground hover:bg-primary-foreground/20'
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
          <span className={cn('size-2 shrink-0 rounded-full', statusDotClassName)} aria-hidden="true" />
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
        <span key={`${index}-${line}`} className={cn('block min-h-[1.25em] whitespace-pre', diffLineClassName(line))}>
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
          <pre className="ml-5 mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-surface-muted/70 p-2 font-mono leading-relaxed text-muted-foreground">
            {payload}
          </pre>
        ) : null}
      </div>
    </article>
  )
}

function toolStatusDotClassName(tool: ChatTranscriptTool) {
  if (tool.error || tool.status === 'failed') return 'bg-destructive'
  if (tool.status !== 'completed') return 'animate-pulse bg-muted-foreground/45'
  return ''
}
