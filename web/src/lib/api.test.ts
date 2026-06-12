import {
  createSession,
  eventStreamURL,
  isAgentType,
  listEvents,
  listSessions,
  updateSessionTitle,
} from '@/lib/api'

test('session API helpers build the expected URLs', async () => {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url) === '/api/sessions?limit=25') {
      return jsonResponse({ sessions: [] })
    }
    if (String(url) === '/api/sessions/sess_1/events?after_seq=4&limit=20') {
      return jsonResponse({ events: [] })
    }
    throw new Error(`unexpected URL ${String(url)}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  await listSessions(25)
  await listEvents('sess_1', 4, 20)

  expect(eventStreamURL('sess_1', 4)).toBe('/api/sessions/sess_1/events/stream?after_seq=4')
})

test('session list helper includes status filters', async () => {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    expect(String(url)).toBe('/api/sessions?limit=25&status=running')
    return jsonResponse({ sessions: [] })
  })
  vi.stubGlobal('fetch', fetchMock)

  await listSessions({ limit: 25, status: 'running' })
})

test('title update helper patches the session title', async () => {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe('/api/sessions/sess_1')
    expect(init?.method).toBe('PATCH')
    expect(init?.body).toBe(JSON.stringify({ title: 'New title' }))
    return jsonResponse({
      id: 'sess_1',
      title: 'New title',
      agent_type: 'fake',
      status: 'idle',
      created_at: '2026-06-12T16:00:00Z',
      updated_at: '2026-06-12T16:01:00Z',
      completed_at: null,
    })
  })
  vi.stubGlobal('fetch', fetchMock)

  const session = await updateSessionTitle('sess_1', 'New title')

  expect(session.title).toBe('New title')
})

test('create session posts agent type and optional title', async () => {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === '/api/sessions') {
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe(JSON.stringify({ agent_type: 'fake', title: 'Inspect repo' }))
      return jsonResponse({ session_id: 'sess_1' })
    }
    if (String(url) === '/api/sessions/sess_1') {
      return jsonResponse({
        id: 'sess_1',
        title: 'Inspect repo',
        agent_type: 'fake',
        status: 'idle',
        created_at: '2026-06-12T16:00:00Z',
        updated_at: '2026-06-12T16:00:00Z',
        completed_at: null,
      })
    }
    throw new Error(`unexpected URL ${String(url)}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const session = await createSession({ agent_type: 'fake', title: 'Inspect repo' })

  expect(session.id).toBe('sess_1')
})

test('agent type validation only accepts known agents', () => {
  expect(isAgentType('fake')).toBe(true)
  expect(isAgentType('codex')).toBe(true)
  expect(isAgentType('other')).toBe(false)
})

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
