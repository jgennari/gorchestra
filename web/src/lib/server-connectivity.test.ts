import { fetchWithServerConnectivity, serverConnectivityEventName, withServerRequestDeadline } from '@/lib/server-connectivity'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

test('gateway errors report unavailability, but unavailable agent options do not', async () => {
  const events: boolean[] = []
  const listener = (event: Event) => events.push((event as CustomEvent<{reachable:boolean}>).detail.reachable)
  window.addEventListener(serverConnectivityEventName, listener)
  try {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('agent unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('gateway', { status: 502 }))
      .mockResolvedValueOnce(Response.json({})))
    await fetchWithServerConnectivity('/api/agents/codex/options')
    await fetchWithServerConnectivity('/api/sessions')
    await fetchWithServerConnectivity('/api/unrelated')
    expect(events).toEqual([false])
  } finally { window.removeEventListener(serverConnectivityEventName, listener) }
})

test('a stalled request or body has a deadline even when the transport ignores abort', async () => {
  vi.useFakeTimers()
  let signal: AbortSignal | undefined
  const pending = withServerRequestDeadline((next) => { signal = next; return new Promise(() => undefined) }, undefined, 100)
  const assertion = expect(pending).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(100)
  await assertion
  expect(signal?.aborted).toBe(true)
})
