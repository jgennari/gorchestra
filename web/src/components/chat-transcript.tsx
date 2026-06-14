import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentEvent } from '@/lib/api'
import type { ChatTranscriptMessage, ChatTranscriptTool } from '@/lib/events'
import { buildChatTranscript } from '@/lib/events'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

type Props = {
  events: AgentEvent[]
  loading?: boolean
  error?: string
}

export function ChatTranscript({ events, loading = false, error = '' }: Props) {
  const messages = useMemo(() => buildChatTranscript(events), [events])
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastSeq = messages.at(-1)?.endSeq ?? 0

  useEffect(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }
    element.scrollTop = element.scrollHeight
  }, [lastSeq])

  if (error && messages.length === 0) {
    return (
      <div role="alert" className="flex h-full items-center justify-center p-8 text-center text-sm text-destructive">
        Failed to load chat history: {error}
      </div>
    )
  }

  if (loading && messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        Loading chat history...
      </div>
    )
  }

  if (messages.length === 0) {
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
        className="h-full min-h-0"
        role="log"
        aria-label="Chat messages"
        aria-live="polite"
        aria-relevant="additions text"
      >
        <div className="space-y-5 p-4 pb-44">
          {messages.map((message) => (
            <ChatMessageRow key={message.id} message={message} />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function ChatMessageRow({ message }: { message: ChatTranscriptMessage }) {
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
              <span>{user ? 'You' : 'Assistant'}</span>
              {message.streaming ? <Badge variant="warning">Streaming</Badge> : null}
            </span>
            {timestamp ? (
              <time className="shrink-0 text-right font-normal tabular-nums" dateTime={message.createdAt}>
                {timestamp}
              </time>
            ) : null}
          </div>

          {message.text ? (
            <MarkdownContent content={message.text} inverted={user} />
          ) : (
            <p className="text-muted-foreground">Working...</p>
          )}
        </div>

        {message.tools.length > 0 ? (
          <div className="mt-2 space-y-1 border-l border-border/80 pl-3">
            {visibleTools.map((tool) => (
              <ToolCallRow key={tool.id} tool={tool} />
            ))}
            {message.tools.length > 3 ? (
              <button
                type="button"
                className="inline-flex items-center gap-0.5 rounded py-0 text-[10px] font-normal leading-none text-muted-foreground/65 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={showAllTools}
                onClick={() => setShowAllTools((current) => !current)}
              >
                {hasHiddenTools ? <ChevronRight className="size-2.5" aria-hidden="true" /> : <ChevronDown className="size-2.5" aria-hidden="true" />}
                {hasHiddenTools ? `Show ${message.tools.length - visibleTools.length} More` : 'Show Less'}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
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
        p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0 whitespace-pre-wrap break-words leading-relaxed">{children}</p>,
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
          const block = className?.startsWith('language-')
          return (
            <code
              className={cn(
                block
                  ? 'block overflow-auto whitespace-pre rounded-md p-3 font-mono text-xs'
                  : 'rounded px-1 py-0.5 font-mono text-[0.85em]',
                inverted ? 'bg-primary-foreground/15' : 'bg-muted',
              )}
            >
              {children}
            </code>
          )
        },
        pre: ({ children }) => <pre className="my-2 overflow-auto">{children}</pre>,
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

function ToolCallRow({ tool }: { tool: ChatTranscriptTool }) {
  const output = tool.error || tool.text
  const [outputOpen, setOutputOpen] = useState(false)
  const name = tool.label.replace(/^Tool:\s*/, '')

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
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
        <span className={cn('shrink-0 text-[11px] capitalize', toolStatusClassName(tool))}>{tool.status}</span>
      </button>
      {output ? (
        outputOpen ? (
          <pre
            className={cn(
              'ml-5 mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-surface-muted/70 p-2 font-mono leading-relaxed text-muted-foreground',
              tool.error && 'text-destructive',
            )}
          >
            {output}
          </pre>
        ) : null
      ) : null}
    </div>
  )
}

function toolStatusClassName(tool: ChatTranscriptTool) {
  if (tool.error || tool.status === 'failed') return 'text-destructive'
  if (tool.status === 'completed') return 'text-emerald-700 dark:text-emerald-400'
  return 'text-amber-700 dark:text-amber-400'
}
