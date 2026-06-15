import {
  answerUserInput,
  archiveSession,
  browseWorkspace,
  clearSession,
  compactSession,
  createSession,
  eventStreamURL,
  fetchAgentOptions,
  getSessionFileContent,
  isAgentType,
  listEvents,
  listEventsBefore,
  listRecentEvents,
  listSessions,
  listSessionFiles,
  listWorkspaceRoots,
  searchSessionFiles,
  submitMessage,
  updateSessionAgentOptions,
  updateSessionFileContent,
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
    if (String(url) === '/api/sessions/sess_1/events?tail=true&limit=25') {
      return jsonResponse({ events: [] })
    }
    if (String(url) === '/api/sessions/sess_1/events?before_seq=100&limit=25') {
      return jsonResponse({ events: [] })
    }
    throw new Error(`unexpected URL ${String(url)}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  await listSessions(25)
  await listEvents('sess_1', 4, 20)
  await listRecentEvents('sess_1', 25)
  await listEventsBefore('sess_1', 100, 25)

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
      workspace_path: '/repo',
      event_count: 0,
      tool_count: 0,
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

test('agent options update helper patches the session options', async () => {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe('/api/sessions/sess_1')
    expect(init?.method).toBe('PATCH')
    expect(init?.body).toBe(JSON.stringify({ agent_options: { codex: { run_dangerously: true } } }))
    return jsonResponse({
      id: 'sess_1',
      title: 'Codex',
      agent_type: 'codex',
      status: 'idle',
      workspace_path: '/repo',
      agent_options: { codex: { run_dangerously: true } },
      event_count: 0,
      tool_count: 0,
      created_at: '2026-06-12T16:00:00Z',
      updated_at: '2026-06-12T16:01:00Z',
      completed_at: null,
      archived_at: null,
    })
  })
  vi.stubGlobal('fetch', fetchMock)

  const session = await updateSessionAgentOptions('sess_1', { codex: { run_dangerously: true } })

  expect(session.agent_options?.codex?.run_dangerously).toBe(true)
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
        workspace_path: '/repo',
        event_count: 0,
        tool_count: 0,
        created_at: '2026-06-12T16:00:00Z',
        updated_at: '2026-06-12T16:00:00Z',
        completed_at: null,
        archived_at: null,
      })
    }
    throw new Error(`unexpected URL ${String(url)}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const session = await createSession({
    agent_type: 'fake',
    title: 'Inspect repo',
  })

  expect(session.id).toBe('sess_1')
})

test('create session can post agent options', async () => {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === '/api/sessions') {
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe(
        JSON.stringify({
          agent_type: 'codex',
          agent_options: { codex: { run_dangerously: true } },
        }),
      )
      return jsonResponse({ session_id: 'sess_1' })
    }
    if (String(url) === '/api/sessions/sess_1') {
      return jsonResponse({
        id: 'sess_1',
        title: '',
        agent_type: 'codex',
        status: 'idle',
        workspace_path: '/repo',
        agent_options: { codex: { run_dangerously: true } },
        event_count: 0,
        tool_count: 0,
        created_at: '2026-06-12T16:00:00Z',
        updated_at: '2026-06-12T16:00:00Z',
        completed_at: null,
        archived_at: null,
      })
    }
    throw new Error(`unexpected URL ${String(url)}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const session = await createSession({
    agent_type: 'codex',
    agent_options: { codex: { run_dangerously: true } },
  })

  expect(session.agent_options?.codex?.run_dangerously).toBe(true)
  expect(session.event_count).toBe(0)
  expect(session.tool_count).toBe(0)
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
      workspace_path: '/repo',
      event_count: 0,
      tool_count: 0,
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

test('session action helpers post to clear and compact endpoints', async () => {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe('POST')
    if (String(url) === '/api/sessions/sess_1/clear') {
      return jsonResponse({ session_id: 'sess_1', status: 'running' })
    }
    if (String(url) === '/api/sessions/sess_1/compact') {
      return jsonResponse({ session_id: 'sess_1', status: 'running' })
    }
    throw new Error(`unexpected URL ${String(url)}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  await expect(clearSession('sess_1')).resolves.toMatchObject({ status: 'running' })
  await expect(compactSession('sess_1')).resolves.toMatchObject({ status: 'running' })
})

test('workspace helpers build the expected URLs', async () => {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    switch (String(url)) {
      case '/api/workspaces/roots':
        return jsonResponse({
          roots: [{ id: 'root_1', name: 'repo', path: '/repo', default: true }],
        })
      case '/api/workspaces/browse?root_id=root_1&path=src':
        return jsonResponse({
          root_id: 'root_1',
          root_path: '/repo',
          path: 'src',
          entries: [],
        })
      case '/api/sessions/sess_1/files?path=src':
        return jsonResponse({ root_path: '/repo', path: 'src', entries: [] })
      case '/api/sessions/sess_1/files/search?q=main&path=src':
        return jsonResponse({ query: 'main', path: 'src', results: [] })
      case '/api/sessions/sess_1/files/content?path=src%2Fmain.go':
        return jsonResponse({
          name: 'main.go',
          path: 'src/main.go',
          size_bytes: 13,
          modified_at: '2026-06-12T16:00:00Z',
          content: 'package main\n',
          encoding: 'utf-8',
          truncated: false,
        })
      default:
        throw new Error(`unexpected URL ${String(url)}`)
    }
  })
  vi.stubGlobal('fetch', fetchMock)

  await listWorkspaceRoots()
  await browseWorkspace('root_1', 'src')
  await listSessionFiles('sess_1', 'src')
  await searchSessionFiles('sess_1', 'main', 'src')
  const content = await getSessionFileContent('sess_1', 'src/main.go')

  expect(content.content).toBe('package main\n')
})

test('workspace file content update helper writes content', async () => {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe('/api/sessions/sess_1/files/content?path=src%2Fmain.go')
    expect(init?.method).toBe('PUT')
    expect(init?.body).toBe(JSON.stringify({ content: 'package main\n' }))
    return jsonResponse({
      name: 'main.go',
      path: 'src/main.go',
      size_bytes: 13,
      modified_at: '2026-06-12T16:00:00Z',
      content: 'package main\n',
      encoding: 'utf-8',
      truncated: false,
    })
  })
  vi.stubGlobal('fetch', fetchMock)

  const content = await updateSessionFileContent('sess_1', 'src/main.go', 'package main\n')

  expect(content.content).toBe('package main\n')
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
    return jsonResponse({
      session_id: 'sess_1',
      request_id: 'call_test',
      status: 'answered',
    })
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
