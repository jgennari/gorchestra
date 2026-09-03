import type { AgentEvent } from '@/lib/api'

export const signalFieldMoteCount = 38
export const signalFieldBurstLimit = 32
export const signalFieldTypingBurstLimit = 18

export type SignalKind =
  | 'user'
  | 'message'
  | 'thinking'
  | 'tool'
  | 'file'
  | 'attention'
  | 'success'
  | 'error'
  | 'ambient'

export type SignalImpulse = {
  kind: SignalKind
  count: number
  strength: number
}

export type SignalPointer = {
  x: number
  y: number
  strength: number
}

export type SignalMote = {
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  phase: number
  depth: number
}

export type SignalBurst = {
  kind: SignalKind
  source: 'event' | 'typing' | 'thinking' | 'pointer'
  x: number
  y: number
  age: number
  lifetime: number
  rotation: number
  spin: number
  strength: number
  pieces: number
  seed: number
}

export type SignalFieldState = {
  seed: number
  time: number
  energy: number
  reasoning: number
  typing: number
  motes: SignalMote[]
  bursts: SignalBurst[]
}

export function signalKindForEvent(event: AgentEvent): SignalKind {
  const type = event.type.toLowerCase()
  const status = event.status.toLowerCase()

  if (status === 'failed' || type.endsWith('.failed') || type.includes('parse_error')) return 'error'
  if (type === 'agent.run.completed') return 'success'
  if (type.startsWith('agent.permission.') || type.startsWith('agent.input.')) return 'attention'
  if (type.startsWith('file.change.')) return 'file'
  if (type.startsWith('tool.call.')) return 'tool'
  if (type.startsWith('agent.thinking.') || type.startsWith('agent.plan.')) return 'thinking'
  if (type.startsWith('user.message.')) return 'user'
  if (type.startsWith('agent.message.')) return 'message'
  return 'ambient'
}

export function collapseSignalEvents(events: AgentEvent[]): SignalImpulse[] {
  const impulses = new Map<SignalKind, SignalImpulse>()
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const kind = signalKindForEvent(event)
    const current = impulses.get(kind) ?? { kind, count: 0, strength: 0 }
    current.count = Math.min(12, current.count + 1)
    current.strength = Math.min(2.4, current.strength + eventStrength(event, kind))
    impulses.set(kind, current)
  }
  return [...impulses.values()]
}

export function signalEventsAfter(events: AgentEvent[], afterSeq: number) {
  const next = events.filter((event) => event.seq > afterSeq).sort((left, right) => left.seq - right.seq)
  const newestSeq = events.reduce((latest, event) => Math.max(latest, event.seq), afterSeq)
  return { events: next, newestSeq }
}

export function latestSignalSequence(events: AgentEvent[]) {
  return events.reduce((latest, event) => Math.max(latest, event.seq), 0)
}

export function createSignalField(seedValue: string): SignalFieldState {
  let seed = hashSignalSeed(seedValue || 'gorchestra')
  const motes: SignalMote[] = []
  for (let index = 0; index < signalFieldMoteCount; index += 1) {
    const x = nextRandom(seed)
    seed = x.seed
    const y = nextRandom(seed)
    seed = y.seed
    const phase = nextRandom(seed)
    seed = phase.seed
    const depth = nextRandom(seed)
    seed = depth.seed
    motes.push({
      x: 0.08 + x.value * 0.84,
      y: 0.08 + y.value * 0.84,
      vx: (y.value - 0.5) * 0.0055,
      vy: (x.value - 0.5) * 0.0055,
      radius: 0.95 + depth.value * 1.85,
      phase: phase.value * Math.PI * 2,
      depth: 0.35 + depth.value * 0.65,
    })
  }
  return { seed, time: 0, energy: 0, reasoning: 0, typing: 0, motes, bursts: [] }
}

export function applySignalImpulses(state: SignalFieldState, impulses: SignalImpulse[]) {
  for (const impulse of impulses) {
    const x = randomFromState(state)
    const y = randomFromState(state)
    const rotation = randomFromState(state)
    const spin = randomFromState(state)
    const burstSeed = state.seed
    const strength = Math.min(2.4, Math.max(0.15, impulse.strength))
    state.bursts.push({
      kind: impulse.kind,
      source: 'event',
      x: 0.12 + x * 0.76,
      y: 0.12 + y * 0.76,
      age: 0,
      lifetime: burstLifetime(impulse.kind) + Math.min(0.8, impulse.count * 0.06),
      rotation: rotation * Math.PI * 2,
      spin: (spin - 0.5) * 1.4,
      strength,
      pieces: Math.min(9, 3 + impulse.count),
      seed: burstSeed,
    })
    state.energy = Math.min(1, state.energy + 0.04 + strength * 0.2)
  }
  if (state.bursts.length > signalFieldBurstLimit) {
    state.bursts.splice(0, state.bursts.length - signalFieldBurstLimit)
  }
}

export function addSignalRipple(state: SignalFieldState, x: number, y: number) {
  state.bursts.push({
    kind: 'user',
    source: 'pointer',
    x: clamp(x, 0, 1),
    y: clamp(y, 0, 1),
    age: 0,
    lifetime: 1.25,
    rotation: randomFromState(state) * Math.PI * 2,
    spin: 0.35,
    strength: 0.55,
    pieces: 4,
    seed: state.seed,
  })
  state.energy = Math.min(1, state.energy + 0.08)
  if (state.bursts.length > signalFieldBurstLimit) state.bursts.shift()
}

export function addTypingSignal(state: SignalFieldState, intensity: number) {
  const strength = clamp(intensity, 0.2, 1)
  trimTypingBursts(state)
  state.bursts.push({
    kind: 'user',
    source: 'typing',
    x: 0.12 + randomFromState(state) * 0.76,
    y: 0.78 + randomFromState(state) * 0.15,
    age: 0,
    lifetime: 1.55 + strength * 0.35,
    rotation: randomFromState(state) * Math.PI * 2,
    spin: (randomFromState(state) - 0.5) * 0.42,
    strength: 0.72 + strength * 0.42,
    pieces: 5 + Math.round(strength * 3),
    seed: state.seed,
  })
  state.typing = Math.min(1, Math.max(0.28, state.typing) + 0.16 + strength * 0.2)
  state.energy = Math.min(1, state.energy + 0.08 + strength * 0.09)
  trimBursts(state)
}

export function addThinkingPulse(state: SignalFieldState) {
  state.bursts.push({
    kind: 'thinking',
    source: 'thinking',
    x: 0.22 + randomFromState(state) * 0.56,
    y: 0.2 + randomFromState(state) * 0.6,
    age: 0,
    lifetime: 5.2,
    rotation: randomFromState(state) * Math.PI * 2,
    spin: (randomFromState(state) - 0.5) * 0.52,
    strength: 1.22,
    pieces: 7,
    seed: state.seed,
  })
  state.energy = Math.min(1, state.energy + 0.14)
  trimBursts(state)
}

export function stepSignalField(
  state: SignalFieldState,
  elapsedSeconds: number,
  pointer?: SignalPointer | null,
  thinkingActive = false,
) {
  const elapsed = clamp(elapsedSeconds, 0, 0.08)
  if (elapsed === 0) return
  state.time += elapsed
  state.energy *= Math.exp(-elapsed * 0.58)
  state.typing *= Math.exp(-elapsed * 0.82)
  if (state.typing < 0.004) state.typing = 0
  const reasoningTarget = thinkingActive ? 1 : 0
  const reasoningRate = thinkingActive ? 1.55 : 0.85
  state.reasoning += (reasoningTarget - state.reasoning) * (1 - Math.exp(-elapsed * reasoningRate))
  if (thinkingActive) state.energy = Math.max(state.energy, 0.24 + state.reasoning * 0.3)
  state.energy = Math.max(state.energy, state.typing * 0.5)

  const attractorX = 0.5 + Math.sin(state.time * 0.17) * 0.09
  const attractorY = 0.5 + Math.cos(state.time * 0.13) * 0.075
  const activityScale = 1 + state.energy * 1.8 + state.reasoning + state.typing * 0.75
  const damping = Math.pow(0.19, elapsed)

  for (const mote of state.motes) {
    const dx = attractorX - mote.x
    const dy = attractorY - mote.y
    const distance = Math.max(0.04, Math.hypot(dx, dy))
    const orbitDirection = Math.sin(mote.phase) >= 0 ? 1 : -1
    const targetRadius = 0.16 + mote.depth * 0.27
    const radialForce = (distance - targetRadius) * 0.018
    const tangentForce =
      (0.0023 + state.energy * 0.0036 + state.reasoning * 0.0028 + state.typing * 0.0025) * orbitDirection

    mote.vx += ((dx / distance) * radialForce + (-dy / distance) * tangentForce) * elapsed * activityScale
    mote.vy += ((dy / distance) * radialForce + (dx / distance) * tangentForce) * elapsed * activityScale

    const curl = Math.sin(state.time * 0.42 + mote.phase + mote.y * 8) * 0.0014
    mote.vx += Math.cos(mote.phase + state.time * 0.11) * curl * elapsed
    mote.vy += Math.sin(mote.phase + state.time * 0.09) * curl * elapsed

    if (pointer && pointer.strength > 0) {
      const pointerDX = pointer.x - mote.x
      const pointerDY = pointer.y - mote.y
      const pointerDistance = Math.max(0.045, Math.hypot(pointerDX, pointerDY))
      if (pointerDistance < 0.38) {
        const pull = (1 - pointerDistance / 0.38) * 0.018 * pointer.strength
        mote.vx += (pointerDX / pointerDistance) * pull * elapsed
        mote.vy += (pointerDY / pointerDistance) * pull * elapsed
      }
    }

    mote.vx *= damping
    mote.vy *= damping
    const speed = Math.hypot(mote.vx, mote.vy)
    const maximumSpeed = 0.023 + state.energy * 0.032 + state.typing * 0.013
    if (speed > maximumSpeed) {
      mote.vx = (mote.vx / speed) * maximumSpeed
      mote.vy = (mote.vy / speed) * maximumSpeed
    }
    mote.x += mote.vx * elapsed * 5.4
    mote.y += mote.vy * elapsed * 5.4
    containMote(mote)
  }

  for (const burst of state.bursts) burst.age += elapsed
  state.bursts = state.bursts.filter((burst) => burst.age < burst.lifetime)
}

export function hashSignalSeed(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0 || 0x9e3779b9
}

function eventStrength(event: AgentEvent, kind: SignalKind) {
  if (kind === 'error') return 1.25
  if (kind === 'success') return 1
  if (kind === 'thinking') {
    if (event.transient || event.type.endsWith('.delta')) return 0.16
    if (event.type.endsWith('.started')) return 0.95
    if (event.type.endsWith('.completed')) return 0.82
    return 0.46
  }
  if (event.transient || event.type.endsWith('.delta')) return 0.14
  if (event.type.endsWith('.started')) return 0.48
  if (event.type.endsWith('.completed') || event.type.endsWith('.resolved')) return 0.72
  return 0.32
}

function burstLifetime(kind: SignalKind) {
  switch (kind) {
    case 'success':
    case 'error':
      return 3.4
    case 'thinking':
      return 4.2
    case 'file':
    case 'tool':
      return 3.1
    default:
      return 2.5
  }
}

function containMote(mote: SignalMote) {
  const edge = 0.035
  if (mote.x < edge || mote.x > 1 - edge) {
    mote.x = clamp(mote.x, edge, 1 - edge)
    mote.vx *= -0.72
  }
  if (mote.y < edge || mote.y > 1 - edge) {
    mote.y = clamp(mote.y, edge, 1 - edge)
    mote.vy *= -0.72
  }
}

function randomFromState(state: SignalFieldState) {
  const random = nextRandom(state.seed)
  state.seed = random.seed
  return random.value
}

function trimBursts(state: SignalFieldState) {
  if (state.bursts.length > signalFieldBurstLimit) {
    state.bursts.splice(0, state.bursts.length - signalFieldBurstLimit)
  }
}

function trimTypingBursts(state: SignalFieldState) {
  const excess = state.bursts.filter((burst) => burst.source === 'typing').length - signalFieldTypingBurstLimit + 1
  for (let removed = 0; removed < excess; removed += 1) {
    const oldestTyping = state.bursts.findIndex((burst) => burst.source === 'typing')
    if (oldestTyping < 0) break
    state.bursts.splice(oldestTyping, 1)
  }
}

function nextRandom(seed: number) {
  let value = seed | 0
  value ^= value << 13
  value ^= value >>> 17
  value ^= value << 5
  const nextSeed = value >>> 0 || 0x9e3779b9
  return { seed: nextSeed, value: nextSeed / 0x1_0000_0000 }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}
