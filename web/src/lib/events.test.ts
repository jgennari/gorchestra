import type { AgentEvent } from '@/lib/api'
import {
  activeThinking,
  appendEvent,
  appendEvents,
  buildChatTranscript,
  buildChatTimeline,
  groupEvents,
  lastSeq,
  latestTokenUsage,
  pendingUserInputRequest,
  statusFromEvent,
} from '@/lib/events'

function event(
  seq: number,
  type = 'agent.message.delta',
  payload: Record<string, unknown> = { text: `event ${seq}` },
): AgentEvent {
  return {
    id: `evt_${seq}`,
    session_id: 'sess_test',
    seq,
    type,
    role: 'assistant',
    status: type.endsWith('.completed') ? 'completed' : 'delta',
    payload,
    created_at: '2026-06-12T16:00:00Z',
  }
}

test('event reducer appends events in sequence order', () => {
  const events = appendEvents([], [event(3), event(1), event(2)])

  expect(events.map((item) => item.seq)).toEqual([1, 2, 3])
  expect(lastSeq(events)).toBe(3)
})

test('event reducer dedupes by sequence', () => {
  const events = appendEvent(
    [event(1, 'agent.message.delta', { text: 'first' })],
    event(1, 'agent.message.delta', { text: 'second' }),
  )

  expect(events).toHaveLength(1)
  expect(events[0].payload).toEqual({ text: 'first' })
})

test('event groups coalesce consecutive agent deltas and keep completion boundaries', () => {
  const groups = groupEvents([
    event(1, 'agent.message.delta', { text: 'Hello' }),
    event(2, 'agent.message.delta', { text: ' world' }),
    event(3, 'agent.message.completed', { text: '' }),
  ])

  expect(groups).toHaveLength(2)
  expect(groups[0].kind).toBe('agent-message')
  expect(groups[0].text).toBe('Hello world')
  expect(groups[0].startSeq).toBe(1)
  expect(groups[0].endSeq).toBe(2)
  expect(groups[1].events[0].type).toBe('agent.message.completed')
})

test('event groups connect tool start and completion by payload identifier', () => {
  const groups = groupEvents([
    event(1, 'tool.call.started', { item_id: 'tool_1', tool: 'shell', command: 'bun test' }),
    event(2, 'tool.call.completed', { item_id: 'tool_1', output: 'ok' }),
  ])

  expect(groups).toHaveLength(1)
  expect(groups[0].kind).toBe('tool-call')
  expect(groups[0].events.map((item) => item.type)).toEqual(['tool.call.started', 'tool.call.completed'])
  expect(groups[0].defaultOpen).toBe(false)
})

test('event groups connect nearby anonymous tool events', () => {
  const groups = groupEvents([
    event(1, 'tool.call.started', { command: 'go test ./...' }),
    event(2, 'tool.call.completed', { output: 'ok' }),
  ])

  expect(groups).toHaveLength(1)
  expect(groups[0].kind).toBe('tool-call')
})

test('event groups combine consecutive log output', () => {
  const groups = groupEvents([
    event(1, 'agent.log.delta', { text: 'line 1\n' }),
    event(2, 'agent.log.delta', { text: 'line 2\n' }),
  ])

  expect(groups).toHaveLength(1)
  expect(groups[0].kind).toBe('log')
  expect(groups[0].text).toBe('line 1\nline 2\n')
})

test('failed and unknown provider event groups use the expected default disclosure', () => {
  const groups = groupEvents([
    event(1, 'provider.codex.parse_error', { error: 'invalid JSON' }),
    event(2, 'provider.codex.event', { provider_event_type: 'thread/compacted' }),
  ])

  expect(groups[0].kind).toBe('error')
  expect(groups[0].defaultOpen).toBe(true)
  expect(groups[1].kind).toBe('unknown')
  expect(groups[1].label).toBe('thread/compacted')
  expect(groups[1].defaultOpen).toBe(false)
})

test('session status update events expose their payload status', () => {
  expect(statusFromEvent(event(1, 'session.status.updated', { status: 'idle' }))).toBe('idle')
  expect(statusFromEvent(event(2, 'session.status.updated', { status: 'bogus' }))).toBeNull()
})

test('pending user input request is derived from replayed events', () => {
  const requested = event(2, 'agent.input.requested', {
    request_id: 'call_test',
    provider: 'codex',
    provider_event_type: 'item/tool/requestUserInput',
    thread_id: 'thread_test',
    turn_id: 'turn_test',
    item_id: 'call_test',
    questions: [
      {
        id: 'question_test',
        header: 'Pick',
        question: 'Pick one',
        is_other: false,
        is_secret: false,
        options: [{ label: 'Beta', description: 'Second' }],
      },
    ],
  })

  expect(pendingUserInputRequest([requested])).toMatchObject({
    requestID: 'call_test',
    questions: [{ id: 'question_test', question: 'Pick one' }],
  })

  expect(pendingUserInputRequest([requested, event(3, 'agent.input.answered', { request_id: 'call_test' })])).toBeNull()
})

test('chat timeline only includes hidden debug events when enabled', () => {
  const events = [
    event(1, 'user.message.completed', { text: 'Hello' }),
    event(2, 'session.status.updated', { status: 'running' }),
    event(3, 'agent.log.delta', { text: 'debug line' }),
    event(4, 'tool.call.started', { item_id: 'tool_1', command: 'go test ./...' }),
    event(5, 'tool.call.completed', { item_id: 'tool_1', output: 'ok' }),
    event(6, 'agent.message.completed', { text: 'Done' }),
  ]

  expect(buildChatTimeline(events, false).map((item) => item.kind)).toEqual(['message', 'message'])

  const debugItems = buildChatTimeline(events, true).filter((item) => item.kind === 'debug')

  expect(debugItems.map((item) => item.event.label)).toEqual(['Session status', 'Log'])
})

test('chat timeline labels provider debug events with provider event type', () => {
  const debugItems = buildChatTimeline(
    [event(1, 'provider.codex.event', { provider_event_type: 'turn/completed' })],
    true,
  ).filter((item) => item.kind === 'debug')

  expect(debugItems.map((item) => item.event.label)).toEqual(['turn/completed'])
})

test('latest token usage is derived from codex provider events', () => {
  const usage = latestTokenUsage([
    event(1, 'provider.codex.event', {
      provider_event_type: 'thread/tokenUsage/updated',
      raw: tokenUsageRaw(1000, 500),
    }),
    event(2, 'provider.codex.event', { provider_event_type: 'turn/completed' }),
    event(3, 'provider.codex.event', {
      provider_event_type: 'thread/tokenUsage/updated',
      raw: tokenUsageRaw(13903, 19),
    }),
  ])

  expect(usage).toMatchObject({
    total: {
      totalTokens: 13903,
      inputTokens: 13884,
      cachedInputTokens: 4480,
      outputTokens: 19,
      reasoningOutputTokens: 0,
    },
    last: {
      totalTokens: 13903,
      inputTokens: 13884,
      cachedInputTokens: 4480,
      outputTokens: 19,
      reasoningOutputTokens: 0,
    },
    modelContextWindow: 258400,
    seq: 3,
  })
})

test('active thinking clears when codex reasoning item completes', () => {
  expect(activeThinking([event(1, 'agent.status.started', { provider_event_type: 'turn/started' })])).toBe(true)

  expect(
    activeThinking([
      event(1, 'agent.status.started', { provider_event_type: 'turn/started' }),
      event(2, 'agent.thinking.completed', {
        provider_event_type: 'item/completed',
        item_type: 'reasoning',
        item_id: 'rs_1',
        text: '',
      }),
    ]),
  ).toBe(false)
})

test('active thinking tracks reasoning item deltas by item id', () => {
  expect(
    activeThinking([
      event(1, 'agent.thinking.delta', { item_id: 'rs_1', text: 'checking' }),
      event(2, 'agent.thinking.delta', { item_id: 'rs_2', text: 'planning' }),
      event(3, 'agent.thinking.completed', { item_id: 'rs_1', text: '' }),
    ]),
  ).toBe(true)

  expect(
    activeThinking([
      event(1, 'agent.thinking.delta', { item_id: 'rs_1', text: 'checking' }),
      event(2, 'agent.thinking.completed', { item_id: 'rs_1', text: '' }),
    ]),
  ).toBe(false)
})

test('chat transcript merges streaming assistant deltas with completion text', () => {
  const transcript = buildChatTranscript([
    event(1, 'user.message.completed', { text: 'Hello' }),
    event(2, 'agent.message.delta', { text: 'Hi' }),
    event(3, 'agent.message.delta', { text: ' there' }),
    event(4, 'agent.message.completed', { text: 'Hi there' }),
  ])

  expect(transcript).toHaveLength(2)
  expect(transcript[0]).toMatchObject({ role: 'user', text: 'Hello' })
  expect(transcript[1]).toMatchObject({ role: 'assistant', text: 'Hi there', streaming: false })
})

test('chat timeline renders session action markers as separators', () => {
  const events = [
    event(1, 'user.message.completed', { text: 'Hello' }),
    event(2, 'session.action.completed', { action: 'clear', text: 'Clear context' }),
    event(3, 'agent.message.completed', { text: 'Done' }),
  ]
  const timeline = buildChatTimeline(events, false)

  expect(timeline.map((item) => item.kind)).toEqual(['message', 'action', 'message'])
  expect(buildChatTranscript(events).map((message) => message.text)).toEqual(['Hello', 'Done'])

  const actionItem = timeline[1]
  expect(actionItem?.kind).toBe('action')
  if (actionItem?.kind !== 'action') {
    throw new Error('expected action timeline item')
  }
  expect(actionItem.action).toMatchObject({
    action: 'clear',
    label: 'CONVERSATION CLEARED',
    startSeq: 2,
    endSeq: 2,
  })
})

test('chat timeline renders legacy user action markers as separators', () => {
  const timeline = buildChatTimeline(
    [event(1, 'user.action.completed', { action: 'compact', text: 'Compact context' })],
    false,
  )

  expect(timeline.map((item) => item.kind)).toEqual(['action'])

  const actionItem = timeline[0]
  expect(actionItem?.kind).toBe('action')
  if (actionItem?.kind !== 'action') {
    throw new Error('expected action timeline item')
  }
  expect(actionItem.action.label).toBe('CONVERSATION COMPACTED')
})

test('chat transcript renders structured plan events as visible plan messages', () => {
  const transcript = buildChatTranscript([
    event(1, 'agent.plan.delta', { item_id: 'plan_1', text: '# Plan\n' }),
    event(2, 'agent.plan.delta', { item_id: 'plan_1', text: '- Check the transcript\n' }),
    event(3, 'agent.plan.completed', { item_id: 'plan_1', text: '# Plan\n- Check the transcript\n' }),
  ])

  expect(transcript).toHaveLength(1)
  expect(transcript[0]).toMatchObject({
    role: 'assistant',
    label: 'Plan',
    variant: 'plan',
    text: '# Plan\n- Check the transcript\n',
    streaming: false,
  })
})

test('chat transcript renders legacy raw Codex plan provider events', () => {
  const transcript = buildChatTranscript([
    event(1, 'provider.codex.event', {
      provider_event_type: 'item/plan/delta',
      raw: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'plan_1', delta: '# Plan\n' },
    }),
    event(2, 'provider.codex.event', {
      provider_event_type: 'item/plan/delta',
      raw: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'plan_1', delta: '- Check the transcript\n' },
    }),
    event(3, 'provider.codex.event', {
      provider_event_type: 'item/completed',
      raw: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        item: { type: 'plan', id: 'plan_1', text: '# Plan\n- Check the transcript\n' },
      },
    }),
  ])

  expect(transcript).toHaveLength(1)
  expect(transcript[0]).toMatchObject({
    role: 'assistant',
    label: 'Plan',
    variant: 'plan',
    text: '# Plan\n- Check the transcript\n',
  })
})

test('chat transcript groups tool calls under the assistant message', () => {
  const transcript = buildChatTranscript([
    event(1, 'user.message.completed', { text: 'Run tests' }),
    event(2, 'tool.call.started', { item_id: 'tool_1', command: 'go test ./...' }),
    event(3, 'tool.call.completed', { item_id: 'tool_1', output: 'ok' }),
    event(4, 'agent.message.completed', { text: 'Tests passed.' }),
  ])

  expect(transcript).toHaveLength(2)
  expect(transcript[1]).toMatchObject({ role: 'assistant', text: 'Tests passed.' })
  expect(transcript[1].tools).toHaveLength(1)
  expect(transcript[1].tools[0]).toMatchObject({
    label: 'Tool: go test ./...',
    status: 'completed',
    text: 'go test ./...\nok',
  })
})

test('chat transcript separates assistant message items and keeps tools in event order', () => {
  const transcript = buildChatTranscript([
    event(1, 'user.message.completed', { text: 'Split this into sections' }),
    event(2, 'agent.message.delta', { item_id: 'msg_1', text: 'Section 1' }),
    event(3, 'agent.message.completed', { item_id: 'msg_1', text: 'Section 1' }),
    event(4, 'tool.call.started', { item_id: 'tool_1', command: '/bin/zsh -lc pwd' }),
    event(5, 'tool.call.completed', { item_id: 'tool_1', output: '/repo' }),
    event(6, 'agent.message.delta', { item_id: 'msg_2', text: 'Section 2' }),
    event(7, 'agent.message.completed', { item_id: 'msg_2', text: 'Section 2' }),
    event(8, 'tool.call.started', { item_id: 'tool_2', command: "/bin/zsh -lc 'git status --short'" }),
    event(9, 'tool.call.completed', { item_id: 'tool_2', output: ' M file.ts' }),
    event(10, 'agent.message.completed', { item_id: 'msg_3', text: 'Done.' }),
  ])

  expect(transcript.map((message) => message.text)).toEqual([
    'Split this into sections',
    'Section 1',
    'Section 2',
    'Done.',
  ])
  expect(transcript[1].tools.map((tool) => tool.label)).toEqual(['Tool: pwd'])
  expect(transcript[2].tools.map((tool) => tool.label)).toEqual(['Tool: git status --short'])
  expect(transcript[3].tools).toHaveLength(0)
})

function tokenUsageRaw(totalTokens: number, outputTokens: number) {
  return {
    tokenUsage: {
      total: {
        totalTokens,
        inputTokens: totalTokens - outputTokens,
        cachedInputTokens: 4480,
        outputTokens,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens,
        inputTokens: totalTokens - outputTokens,
        cachedInputTokens: 4480,
        outputTokens,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 258400,
    },
  }
}

test('chat transcript dedupes repeated shell command text in tool output', () => {
  const transcript = buildChatTranscript([
    event(1, 'agent.message.completed', { item_id: 'msg_1', text: 'Checking.' }),
    event(2, 'tool.call.started', { item_id: 'tool_1', command: '/bin/zsh -lc pwd' }),
    event(3, 'tool.call.completed', { item_id: 'tool_1', command: '/bin/zsh -lc pwd' }),
  ])

  expect(transcript[0].tools[0]).toMatchObject({
    label: 'Tool: pwd',
    text: 'pwd',
  })
})

test('chat transcript includes codex command aggregated output in tool details', () => {
  const transcript = buildChatTranscript([
    event(1, 'agent.message.completed', { item_id: 'msg_1', text: 'Listing files.' }),
    event(2, 'tool.call.started', { item_id: 'tool_1', command: "/bin/zsh -lc 'ls -la'" }),
    event(3, 'tool.call.completed', {
      item_id: 'tool_1',
      command: "/bin/zsh -lc 'ls -la'",
      aggregated_output: 'total 56\nREADME.md\nweb\n',
      exit_code: 0,
    }),
  ])

  expect(transcript[0].tools[0]).toMatchObject({
    label: 'Tool: ls -la',
    status: 'completed',
    text: 'ls -la\ntotal 56\nREADME.md\nweb\n',
  })
})

test('chat transcript labels file changes as edits and shows emitted patches', () => {
  const transcript = buildChatTranscript([
    event(1, 'agent.message.completed', { item_id: 'msg_1', text: 'Updating tests.' }),
    event(2, 'file.change.started', {
      item_id: 'edit_1',
      paths: ['/Users/joey/Source/gorchestra/internal/httpapi/sessions_test.go'],
    }),
    event(3, 'file.change.completed', {
      item_id: 'edit_1',
      changes: [
        {
          path: '/Users/joey/Source/gorchestra/internal/httpapi/sessions_test.go',
          patch: '@@ -1,3 +1,3 @@\n-old line\n+new line',
        },
      ],
    }),
  ])

  expect(transcript[0].tools[0]).toMatchObject({
    label: 'sessions_test.go',
    status: 'completed',
    text: '@@ -1,3 +1,3 @@\n-old line\n+new line',
  })
})

test('chat transcript falls back to file paths when file change diffs are unavailable', () => {
  const transcript = buildChatTranscript([
    event(1, 'agent.message.completed', { item_id: 'msg_1', text: 'Updating files.' }),
    event(2, 'file.change.completed', {
      item_id: 'edit_1',
      paths: [
        '/Users/joey/Source/gorchestra/internal/httpapi/sessions_test.go',
        '/Users/joey/Source/gorchestra/internal/httpapi/sessions.go',
      ],
    }),
  ])

  expect(transcript[0].tools[0]).toMatchObject({
    label: 'sessions_test.go +1',
    text: [
      '/Users/joey/Source/gorchestra/internal/httpapi/sessions_test.go',
      '/Users/joey/Source/gorchestra/internal/httpapi/sessions.go',
    ].join('\n'),
  })
})

test('chat transcript labels web search tools from completed query metadata', () => {
  const transcript = buildChatTranscript([
    event(1, 'agent.message.completed', { item_id: 'msg_1', text: 'Checking weather.' }),
    event(2, 'tool.call.started', {
      item_id: 'web_1',
      item_type: 'webSearch',
      action: { type: 'other' },
      query: '',
    }),
    event(3, 'tool.call.completed', {
      item_id: 'web_1',
      item_type: 'webSearch',
      action: {
        type: 'search',
        query: 'weather: 33445, United States',
        queries: ['weather: 33445, United States'],
      },
      query: 'weather: 33445, United States',
    }),
  ])

  expect(transcript[0].tools[0]).toMatchObject({
    label: 'Tool: Web search: weather: 33445, United States',
    text: ['Query: weather: 33445, United States', 'Queries:', '- weather: 33445, United States'].join('\n'),
  })
})
