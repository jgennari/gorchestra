import { ChevronDown, ChevronUp, Copy, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ClientDebugSnapshot } from '@/lib/client-debug'
import { clipboardCopyErrorMessage, copyText } from '@/lib/clipboard'
import { gorchestraVersion } from '@/lib/releases'

export function ClientDebugPanel({ readSnapshot, onClose }: {
  readSnapshot: () => ClientDebugSnapshot
  onClose: () => void
}) {
  const readerRef = useRef(readSnapshot)
  const probeRef = useRef<HTMLDivElement | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [copyStatus, setCopyStatus] = useState('')
  const [snapshot, setSnapshot] = useState<ReturnType<typeof sample> | null>(null)

  useEffect(() => { readerRef.current = readSnapshot }, [readSnapshot])
  useEffect(() => {
    function update() {
      if (document.visibilityState !== 'hidden') {
        setSnapshot(sample(readerRef.current(), probeRef.current))
      }
    }
    update()
    // Only the debug panel rerenders; never poll the server or the whole app.
    const timer = window.setInterval(update, 1000)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])

  async function copyDiagnostics() {
    if (!snapshot) return
    // Message contents are useful on-screen but intentionally not in the export.
    const diagnostics = { ...snapshot, preview: undefined }
    try {
      await copyText(JSON.stringify(diagnostics, null, 2))
      setCopyStatus('Copied (message text excluded)')
    } catch {
      setCopyStatus(clipboardCopyErrorMessage)
    }
  }

  return (
    <aside aria-label="Client debug" className="client-debug-panel rounded-xl border border-amber-400/50 bg-background/95 text-foreground shadow-xl backdrop-blur">
      <div ref={probeRef} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-0 w-0 overflow-hidden" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }} />
      <div className="flex items-center gap-1 px-2 py-1">
        <button type="button" aria-expanded={!collapsed} aria-controls="client-debug-body" onClick={() => setCollapsed(!collapsed)} className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded px-2 text-left text-xs font-semibold hover:bg-muted">
          {collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          Client debug
          <span className="truncate font-mono text-[10px] font-normal text-muted-foreground">{snapshot?.stream.connection ?? 'sampling'}</span>
        </button>
        <button type="button" aria-label="Copy debug diagnostics" onClick={() => void copyDiagnostics()} className="flex size-9 shrink-0 items-center justify-center rounded hover:bg-muted"><Copy className="size-3.5" /></button>
        <button type="button" aria-label="Close debug view" onClick={onClose} className="flex size-9 shrink-0 items-center justify-center rounded hover:bg-muted"><X className="size-3.5" /></button>
      </div>
      <div id="client-debug-body" hidden={collapsed} className="client-debug-body space-y-3 border-t border-border/70 p-3 font-mono text-[11px] leading-4">
        <p className="text-[10px] text-muted-foreground">Local only · sampled 1/s · ⌘/Ctrl+D to toggle</p>
        {copyStatus ? <p role="status">{copyStatus}</p> : null}
        {snapshot ? <>
          <DebugSection title="Global SSE" values={snapshot.stream} />
          <DebugSection title="Selected history" values={snapshot.history} />
          <section>
            <h3 className="mb-1 font-sans text-xs font-semibold text-amber-400">Last loaded message</h3>
            <p>{snapshot.message}</p>
            <p className="mt-1 break-words text-muted-foreground">{snapshot.preview}</p>
          </section>
          <DebugSection title="Scroll" values={snapshot.scroll} />
          <details><summary className="cursor-pointer font-sans text-xs font-semibold text-amber-400">Viewport &amp; bundle</summary><div className="mt-2"><DebugValues values={snapshot.viewport} /></div></details>
        </> : <p>Waiting for first sample…</p>}
      </div>
    </aside>
  )
}

function DebugSection({ title, values }: { title: string; values: Record<string, string> }) {
  return <section><h3 className="mb-1 font-sans text-xs font-semibold text-amber-400">{title}</h3><DebugValues values={values} /></section>
}

function DebugValues({ values }: { values: Record<string, string> }) {
  return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
    {Object.entries(values).map(([label, value]) => <div className="contents" key={label}>
      <dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-words [overflow-wrap:anywhere]">{value}</dd>
    </div>)}
  </dl>
}

function sample(snapshot: ClientDebugSnapshot, probe: HTMLElement | null) {
  const readout = document.querySelector<HTMLElement>('[data-debug-scroll-readout]')
  const scroller = readout?.closest('.chat-canvas')?.querySelector('.chat-scroll-area')
  const max = scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0
  return {
    sampledAt: new Date().toISOString(),
    ...snapshot,
    scroll: {
      state: readout?.textContent ?? 'No transcript mounted',
      position: scroller ? `${Math.round(scroller.scrollTop)} / ${Math.round(max)}px` : 'n/a',
      distance: scroller ? `${Math.round(Math.max(0, max - scroller.scrollTop))}px from bottom` : 'n/a',
    },
    viewport: viewportSnapshot(probe),
  }
}

function viewportSnapshot(probe: HTMLElement | null): Record<string, string> {
  const viewport = window.visualViewport
  const root = document.documentElement
  const rect = document.querySelector('.app-shell')?.getBoundingClientRect()
  const entry = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'))
    .find((script) => !script.src.includes('/@vite/client'))
  const round = (value: number) => Math.round(value * 100) / 100
  return {
    inner: `${window.innerWidth} × ${window.innerHeight}`,
    outer: `${window.outerWidth} × ${window.outerHeight}`,
    document: `${root.clientWidth} × ${root.clientHeight}`,
    visual: viewport ? `${round(viewport.width)} × ${round(viewport.height)} scale ${round(viewport.scale)}` : 'n/a',
    offset: viewport ? `top ${round(viewport.offsetTop)} pageTop ${round(viewport.pageTop)}` : 'n/a',
    scroll: `${round(window.scrollX)}, ${round(window.scrollY)}`,
    safeTop: probe ? getComputedStyle(probe).paddingTop : 'n/a',
    app: rect ? `top ${round(rect.top)} bottom ${round(rect.bottom)} height ${round(rect.height)}` : 'n/a',
    screen: `${window.screen.width} × ${window.screen.height} avail ${window.screen.availHeight}`,
    dpr: String(round(window.devicePixelRatio)),
    version: gorchestraVersion,
    entry: entry?.getAttribute('src') ?? 'unknown',
    worker: navigator.serviceWorker?.controller?.scriptURL ?? 'not controlled',
  }
}
