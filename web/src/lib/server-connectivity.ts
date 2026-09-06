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
    reportServerConnectivity(true)
    return response
  } catch (error) {
    if (isNetworkRequestError(error)) reportServerConnectivity(false)
    throw error
  }
}
