import type { AgentEvent } from '@/lib/api'
import { appendEvent, appendEvents, buildChatTranscript, groupEvents, lastSeq, statusFromEvent } from '@/lib/events'

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
  const events = appendEvent([event(1, 'agent.message.delta', { text: 'first' })], event(1, 'agent.message.delta', { text: 'second' }))

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
  expect(groups[1].defaultOpen).toBe(false)
})

test('session status update events expose their payload status', () => {
  expect(statusFromEvent(event(1, 'session.status.updated', { status: 'idle' }))).toBe('idle')
  expect(statusFromEvent(event(2, 'session.status.updated', { status: 'bogus' }))).toBeNull()
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
