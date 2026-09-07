export const serverConnectivityEventName = 'gorchestra:server-connectivity'

export type ServerConnectivityDetail = {
  reachable: boolean
}

export function browserIsOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

export function isNetworkRequestError(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError') return false
  return error instanceof TypeError
}

export function reportServerConnectivity(reachable: boolean) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<ServerConnectivityDetail>(serverConnectivityEventName, {
      detail: { reachable },
    }),
  )
}

export async function fetchWithServerConnectivity(input: RequestInfo | URL, init?: RequestInit) {
  try {
    const response = await fetch(input, init)
    // Recovery is established by a successful session snapshot/stream, not an
    // unrelated response (which might even be a gateway's error page).
    if (response.status >= 500) reportServerConnectivity(false)
    return response
  } catch (error) {
    if (isNetworkRequestError(error)) reportServerConnectivity(false)
    throw error
  }
}

export const serverRequestTimeoutMs = 30_000

export async function withServerRequestDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal | null,
  timeoutMs = serverRequestTimeoutMs,
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort(parentSignal?.reason)
  if (parentSignal?.aborted) abort()
  else parentSignal?.addEventListener('abort', abort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new TypeError('Server request timed out. Delivery may be uncertain; check before retrying.')
          controller.abort(error)
          reportServerConnectivity(false)
          reject(error)
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener('abort', abort)
  }
}
