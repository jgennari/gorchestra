import type { AgentEvent } from '@/lib/api'
import {
  appendBoundedEvent,
  boundEventWindow,
  eventWindowStats,
  mergeBoundedEvents,
  type EventWindowPolicy,
} from '@/lib/session-event-window'

const smallPolicy: EventWindowPolicy = {
  maxTurns: 2,
  maxDurableEvents: 6,
  maxBytes: 10_000,
  maxTransientEvents: 2,
  maxTransientBytes: 10_000,
}

test('bounds live growth from the oldest edge by turns', () => {
  const result = boundEventWindow(
    [
      event(1, 'user.message.completed'),
      event(2, 'agent.message.completed'),
      event(3, 'user.message.completed'),
      event(4, 'agent.message.completed'),
      event(5, 'user.message.completed'),
      event(6, 'agent.message.completed'),
    ],
    'latest',
    smallPolicy,
  )

  expect(result.events.map((item) => item.seq)).toEqual([3, 4, 5, 6])
  expect(result.trimmedStart).toBe(true)
})

test('loading older evicts from the newest edge', () => {
  const result = mergeBoundedEvents(
    [event(5, 'user.message.completed'), event(6, 'agent.message.completed')],
    [
      event(1, 'user.message.completed'),
      event(2, 'agent.message.completed'),
      event(3, 'user.message.completed'),
      event(4, 'agent.message.completed'),
    ],
    'oldest',
    smallPolicy,
  )

  expect(result.events.map((item) => item.seq)).toEqual([1, 2, 3, 4])
  expect(result.trimmedEnd).toBe(true)
})

test('coalesces transient chunks and drops them on completion', () => {
  let current = appendBoundedEvent([], transient(1, 'agent.message.delta', 'Hel'), smallPolicy).events
  current = appendBoundedEvent(current, transient(2, 'agent.message.delta', 'lo'), smallPolicy).events

  expect(current).toHaveLength(1)
  expect(current[0].payload).toMatchObject({ text: 'Hello' })

  current = appendBoundedEvent(current, event(3, 'agent.message.completed', 'Hello'), smallPolicy).events
  expect(current.map((item) => item.type)).toEqual(['agent.message.completed'])
})

test('terminal events clear unmatched transient activity', () => {
  const result = appendBoundedEvent(
    [transient(1, 'agent.log.delta', 'one'), transient(2, 'tool.call.delta', 'two')],
    event(3, 'agent.run.completed'),
    smallPolicy,
  )

  expect(result.events.map((item) => item.type)).toEqual(['agent.run.completed'])
})

test('enforces durable event and transient ceilings inside one turn', () => {
  const result = boundEventWindow(
    [
      event(1, 'user.message.completed'),
      event(2, 'tool.call.started'),
      event(3, 'tool.call.completed'),
      event(4, 'tool.call.started'),
      event(5, 'tool.call.completed'),
      event(6, 'agent.message.completed'),
      transient(7, 'agent.log.delta', 'a'),
      transient(8, 'agent.thinking.delta', 'b'),
      transient(9, 'agent.plan.delta', 'c'),
    ],
    'latest',
    smallPolicy,
  )

  const stats = eventWindowStats(result.events)
  expect(stats.durableEvents).toBeLessThanOrEqual(smallPolicy.maxDurableEvents)
  expect(stats.transientEvents).toBeLessThanOrEqual(smallPolicy.maxTransientEvents)
  expect(result.trimmedStart).toBe(true)
})

test('compacts a single event that exceeds the byte window', () => {
  const result = boundEventWindow(
    [{ ...event(1, 'agent.message.completed'), payload: { text: 'x'.repeat(2048) } }],
    'latest',
    { ...smallPolicy, maxBytes: 512 },
  )

  expect(result.events).toHaveLength(1)
  expect(result.events[0].payload).toEqual({ _gorchestra_window_truncated: true })
  expect(eventWindowStats(result.events).bytes).toBeLessThanOrEqual(512)
})

function event(seq: number, type: string, text = `event ${seq}`): AgentEvent {
  return {
    id: `evt_${seq}`,
    session_id: 'sess_1',
    seq,
    type,
    role: type.startsWith('user.') ? 'user' : 'assistant',
    status: 'completed',
    payload: { message_id: 'message_1', text },
    created_at: '2026-07-14T12:00:00Z',
  }
}

function transient(seq: number, type: string, text: string): AgentEvent {
  return { ...event(seq, type, text), status: 'delta', transient: true }
}
