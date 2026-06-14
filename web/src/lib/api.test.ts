import {
  answerUserInput,
  archiveSession,
  createSession,
  eventStreamURL,
  fetchAgentOptions,
  isAgentType,
  listEvents,
  listSessions,
  submitMessage,
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
      archived_at: null,
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
        archived_at: null,
      })
    }
    throw new Error(`unexpected URL ${String(url)}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const session = await createSession({ agent_type: 'fake', title: 'Inspect repo' })

  expect(session.id).toBe('sess_1')
})

test('archive session posts to the archive endpoint', async () => {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe('/api/sessions/sess_1/archive')
    expect(init?.method).toBe('POST')
    return jsonResponse({
      id: 'sess_1',
      title: 'Inspect repo',
      agent_type: 'fake',
      status: 'idle',
      created_at: '2026-06-12T16:00:00Z',
      updated_at: '2026-06-12T16:05:00Z',
      completed_at: null,
      archived_at: '2026-06-12T16:05:00Z',
    })
  })
  vi.stubGlobal('fetch', fetchMock)

  const session = await archiveSession('sess_1')

  expect(session.archived_at).toBe('2026-06-12T16:05:00Z')
})

test('agent options helper fetches codex options', async () => {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    expect(String(url)).toBe('/api/agents/codex/options')
    return jsonResponse({
      default_model: 'gpt-5.5',
      models: [],
      collaboration_modes: [],
    })
  })
  vi.stubGlobal('fetch', fetchMock)

  const options = await fetchAgentOptions('codex')

  expect(options.default_model).toBe('gpt-5.5')
})

test('submit message posts codex agent options when provided', async () => {
  const agentOptions = {
    codex: {
      model: 'gpt-5.5',
      reasoning_effort: 'xhigh',
      fast_mode: true,
      planning_mode: true,
      service_tier: 'priority',
    },
  }
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe('/api/sessions/sess_1/messages')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify({ content: 'Hello', agent_options: agentOptions }))
    return jsonResponse({ session_id: 'sess_1', status: 'running' })
  })
  vi.stubGlobal('fetch', fetchMock)

  const response = await submitMessage('sess_1', 'Hello', agentOptions)

  expect(response.status).toBe('running')
})

test('submit message posts image attachments when provided', async () => {
  const attachments = [
    {
      name: 'diagram.png',
      media_type: 'image/png',
      data_url: 'data:image/png;base64,aGVsbG8=',
      size_bytes: 5,
    },
  ]
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe('/api/sessions/sess_1/messages')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify({ content: '', attachments }))
    return jsonResponse({ session_id: 'sess_1', status: 'running' })
  })
  vi.stubGlobal('fetch', fetchMock)

  const response = await submitMessage('sess_1', '', undefined, attachments)

  expect(response.status).toBe('running')
})

test('answer user input posts selected answers', async () => {
  const answers = {
    question_test: {
      answers: ['Beta'],
    },
  }
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe('/api/sessions/sess_1/requests/call_test/answer')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify({ answers }))
    return jsonResponse({ session_id: 'sess_1', request_id: 'call_test', status: 'answered' })
  })
  vi.stubGlobal('fetch', fetchMock)

  const response = await answerUserInput('sess_1', 'call_test', answers)

  expect(response.status).toBe('answered')
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
