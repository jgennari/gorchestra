import workerSource from '../../public/service-worker.js?raw'
import { describe, expect, it, vi } from 'vitest'

function fixture() {
  const entries = new Map<string, Map<string, Response>>()
  const caches = {
    open: async (name: string) => {
      if (!entries.has(name)) entries.set(name, new Map())
      const values = entries.get(name)!
      return {
        match: async (key: string) => values.get(key)?.clone(),
        put: async (key: string, value: Response) => { values.set(key, value.clone()) },
      }
    },
  }
  const fetch = vi.fn(async (path: RequestInfo | URL) => new Response('asset', { headers: { 'Content-Type': String(path).endsWith('.css') ? 'text/css' : 'application/javascript' } }))
  const worker = new Function('self', 'caches', 'fetch', workerSource +
    '\nreturn {cacheAppShellResponse, appShellResponse}')( { addEventListener: vi.fn() }, caches, fetch,
  ) as {
    cacheAppShellResponse: (response: Response) => Promise<void>
    appShellResponse: (event: { request: Request; waitUntil: (task: Promise<void>) => void }) => Promise<Response>
  }
  const shell = (version: string) => new Response(
    `<script src="/assets/${version}.js"></script><link href="/assets/${version}.css">`,
    { headers: { 'Content-Type': 'text/html' } },
  )
  const cachedShell = async () => (await (await caches.open('gorchestra-app-shell-v1')).match('/__gorchestra_app_shell__'))?.text()
  return { worker, fetch, shell, cachedShell }
}

describe('atomic offline shell updates', () => {
  it.each(['http', 'network', 'html'])('retains A if required B assets fail (%s)', async (failure) => {
    const { worker, fetch, shell, cachedShell } = fixture()
    await worker.cacheAppShellResponse(shell('a'))
    if (failure === 'http') fetch.mockResolvedValue(new Response('unavailable', { status: 503 }))
    else if (failure === 'html') fetch.mockResolvedValue(new Response('<html>gateway</html>', { headers: { 'Content-Type': 'text/html' } }))
    else fetch.mockRejectedValue(new Error(failure))
    await expect(worker.cacheAppShellResponse(shell('b'))).rejects.toThrow()
    expect(await cachedShell()).toContain('/assets/a.js')
    expect(await cachedShell()).not.toContain('/assets/b.js')
  })

  it('publishes B only after all required assets are cached', async () => {
    const { worker, fetch, shell, cachedShell } = fixture()
    await worker.cacheAppShellResponse(shell('a'))
    let finish!: (response: Response) => void
    fetch.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve }))
    const update = worker.cacheAppShellResponse(new Response('<script src="/assets/b.js"></script>', { headers: { 'Content-Type': 'text/html' } }))
    await vi.waitFor(() => expect(finish).toBeDefined())
    expect(await cachedShell()).toContain('/assets/a.js')
    finish(new Response('asset b', { headers: { 'Content-Type': 'application/javascript' } }))
    await update
    expect(await cachedShell()).toContain('/assets/b.js')
  })
})

describe('app shell navigation', () => {
  it('serves the current network shell instead of a stale cached shell', async () => {
    const { worker, fetch, shell, cachedShell } = fixture()
    await worker.cacheAppShellResponse(shell('a'))
    fetch.mockImplementation(async (input) => {
      if (input instanceof Request) return shell('b')
      return new Response('asset b', {
        headers: { 'Content-Type': String(input).endsWith('.css') ? 'text/css' : 'application/javascript' },
      })
    })
    const backgroundTasks: Promise<void>[] = []

    const response = await worker.appShellResponse({
      request: new Request('https://gorchestra.test/sessions/example'),
      waitUntil: (task) => backgroundTasks.push(task),
    })

    expect(await response.text()).toContain('/assets/b.js')
    await Promise.all(backgroundTasks)
    expect(await cachedShell()).toContain('/assets/b.js')
  })

  it('uses the cached shell when navigation is offline', async () => {
    const { worker, fetch, shell } = fixture()
    await worker.cacheAppShellResponse(shell('a'))
    fetch.mockRejectedValue(new Error('offline'))

    const response = await worker.appShellResponse({
      request: new Request('https://gorchestra.test/sessions/example'),
      waitUntil: () => undefined,
    })

    expect(await response.text()).toContain('/assets/a.js')
  })
})
