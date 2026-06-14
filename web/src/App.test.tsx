import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '@/App'
import type { Session } from '@/lib/api'

const firstSession = session('sess_1', 'Inspect repo', '2026-06-12T16:02:00Z')
const secondSession = session('sess_2', 'Write docs', '2026-06-12T16:01:00Z')

beforeEach(() => {
  window.history.replaceState({}, '', '/')
  window.localStorage.clear()
  vi.stubGlobal('fetch', fetchMock())
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('matchMedia', matchMediaMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('selecting a session updates the browser route', async () => {
  const user = userEvent.setup()

  render(<App />)

  await waitFor(() => expect(screen.getAllByText('Inspect repo').length).toBeGreaterThan(0))
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/sess_1'))

  await user.click(screen.getAllByRole('button', { name: /Write docs/ })[0])

  await waitFor(() => expect(window.location.pathname).toBe('/sessions/sess_2'))
})

test('loading with a session route selects that session', async () => {
  window.history.replaceState({}, '', '/sessions/sess_2')

  render(<App />)

  await waitFor(() => expect(screen.getAllByText('Write docs').length).toBeGreaterThan(0))
  await waitFor(() => expect(window.location.pathname).toBe('/sessions/sess_2'))
  expect(screen.getAllByRole('button', { name: /Write docs/ }).some((button) => (
    button.getAttribute('aria-current') === 'true'
  ))).toBe(true)
})

function fetchMock() {
  return vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path === '/api/health') {
      return jsonResponse({ status: 'ok' })
    }
    if (path === '/api/sessions?limit=50') {
      return jsonResponse({ sessions: [firstSession, secondSession] })
    }
    if (path === '/api/sessions/sess_1') {
      return jsonResponse(firstSession)
    }
    if (path === '/api/sessions/sess_2') {
      return jsonResponse(secondSession)
    }
    if (path === '/api/sessions/sess_1/events?after_seq=0&limit=1000') {
      return jsonResponse({ events: [] })
    }
    if (path === '/api/sessions/sess_2/events?after_seq=0&limit=1000') {
      return jsonResponse({ events: [] })
    }
    throw new Error(`unexpected URL ${path}`)
  })
}

class FakeEventSource {
  url: string
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
    window.setTimeout(() => this.onopen?.(new Event('open')), 0)
  }

  addEventListener() {}

  close() {}
}

function matchMediaMock(query: string): MediaQueryList {
  return {
    media: query,
    matches: false,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }
}

function session(id: string, title: string, updatedAt: string): Session {
  return {
    id,
    title,
    agent_type: 'fake',
    status: 'idle',
    created_at: '2026-06-12T16:00:00Z',
    updated_at: updatedAt,
    completed_at: null,
    archived_at: null,
  }
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
