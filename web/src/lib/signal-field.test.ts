import type { AgentEvent } from '@/lib/api'
import {
  addThinkingPulse,
  addTypingSignal,
  applySignalImpulses,
  collapseSignalEvents,
  createSignalField,
  hashSignalSeed,
  latestSignalSequence,
  signalEventsAfter,
  signalFieldBurstLimit,
  signalFieldMoteCount,
  signalFieldTypingBurstLimit,
  signalKindForEvent,
  stepSignalField,
} from '@/lib/signal-field'

test.each([
  ['user.message.completed', 'completed', 'user'],
  ['agent.message.delta', 'started', 'message'],
  ['agent.thinking.started', 'started', 'thinking'],
  ['agent.plan.completed', 'completed', 'thinking'],
  ['tool.call.started', 'started', 'tool'],
  ['file.change.completed', 'completed', 'file'],
  ['agent.permission.requested', 'started', 'attention'],
  ['agent.input.answered', 'completed', 'attention'],
  ['agent.run.completed', 'completed', 'success'],
  ['agent.run.failed', 'failed', 'error'],
  ['provider.codex.parse_error', 'completed', 'error'],
  ['provider.codex.event', 'completed', 'ambient'],
] as const)('maps %s events to %s', (type, status, expected) => {
  expect(signalKindForEvent(event(1, type, status))).toBe(expected)
})

test('coalesces a rapid batch into one bounded impulse per visual kind', () => {
  const events = Array.from({ length: 30 }, (_, index) =>
    event(index + 1, index % 2 === 0 ? 'agent.message.delta' : 'tool.call.delta', 'started', true),
  )

  const impulses = collapseSignalEvents(events)

  expect(impulses).toHaveLength(2)
  expect(impulses.map((impulse) => impulse.kind)).toEqual(['message', 'tool'])
  expect(impulses.every((impulse) => impulse.count === 12)).toBe(true)
  expect(impulses.every((impulse) => impulse.strength <= 2.4)).toBe(true)
})

test('selects only events beyond the processed sequence without depending on array order', () => {
  const batch = signalEventsAfter(
    [event(8, 'tool.call.completed'), event(6, 'agent.message.delta'), event(7, 'file.change.started')],
    6,
  )

  expect(batch.events.map((item) => item.seq)).toEqual([7, 8])
  expect(batch.newestSeq).toBe(8)
  expect(latestSignalSequence(batch.events)).toBe(8)
})

test('creates a deterministic bounded field and decays its activity', () => {
  const first = createSignalField('session-one')
  const second = createSignalField('session-one')
  expect(first.motes).toEqual(second.motes)
  expect(first.motes).toHaveLength(signalFieldMoteCount)
  expect(hashSignalSeed('session-one')).toBe(hashSignalSeed('session-one'))

  const impulses = Array.from({ length: signalFieldBurstLimit + 8 }, () => ({
    kind: 'tool' as const,
    count: 2,
    strength: 0.8,
  }))
  applySignalImpulses(first, impulses)
  expect(first.bursts).toHaveLength(signalFieldBurstLimit)
  expect(first.energy).toBe(1)

  const initialEnergy = first.energy
  stepSignalField(first, 0.08)
  expect(first.energy).toBeLessThan(initialEnergy)
  expect(first.motes.every((mote) => mote.x >= 0.035 && mote.x <= 0.965)).toBe(true)
  expect(first.motes.every((mote) => mote.y >= 0.035 && mote.y <= 0.965)).toBe(true)
})

test('turns every local edit into a bounded particle burst near the composer', () => {
  const field = createSignalField('typing')

  addTypingSignal(field, 0.3)
  addTypingSignal(field, 0.8)

  expect(field.bursts).toHaveLength(2)
  expect(field.bursts[0]).toMatchObject({ kind: 'user', source: 'typing' })
  expect(field.bursts[0].y).toBeGreaterThanOrEqual(0.78)
  expect(field.bursts[0].y).toBeLessThanOrEqual(0.93)
  expect(field.bursts[0].pieces).toBeGreaterThanOrEqual(5)
  expect(field.typing).toBeGreaterThan(0.5)
  expect(field.energy).toBeGreaterThan(0)

  for (let index = 0; index < signalFieldTypingBurstLimit + 8; index += 1) addTypingSignal(field, 0.3)
  expect(field.bursts.filter((burst) => burst.source === 'typing')).toHaveLength(signalFieldTypingBurstLimit)
})

test('holds a visible reasoning charge while thinking and lets it recede afterward', () => {
  const field = createSignalField('thinking')
  addThinkingPulse(field)

  expect(field.bursts[0]).toMatchObject({ kind: 'thinking', source: 'thinking' })
  stepSignalField(field, 0.08, null, true)
  const activeReasoning = field.reasoning
  expect(activeReasoning).toBeGreaterThan(0)
  expect(field.energy).toBeGreaterThanOrEqual(0.24)

  for (let index = 0; index < 20; index += 1) stepSignalField(field, 0.08, null, false)
  expect(field.reasoning).toBeLessThan(activeReasoning)
})

function event(seq: number, type: string, status = 'completed', transient = false): AgentEvent {
  return {
    id: `evt_${seq}`,
    session_id: 'sess_1',
    seq,
    type,
    role: 'assistant',
    status,
    payload: {},
    created_at: '2026-09-03T12:00:00Z',
    transient,
  }
}
