import { Orbit } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { AgentEvent } from '@/lib/api'
import type { StreamState } from '@/hooks/use-session-events'
import { subscribeComposerActivity } from '@/lib/composer-activity'
import {
  addSignalRipple,
  addThinkingPulse,
  addTypingSignal,
  applySignalImpulses,
  collapseSignalEvents,
  createSignalField,
  latestSignalSequence,
  signalEventsAfter,
  stepSignalField,
  type SignalBurst,
  type SignalFieldState,
  type SignalKind,
  type SignalPointer,
} from '@/lib/signal-field'
import { cn } from '@/lib/utils'

type Props = {
  sessionID: string | null
  events: AgentEvent[]
  active: boolean
  running: boolean
  thinking: boolean
  streamState: StreamState
  className?: string
}

type CanvasSize = {
  width: number
  height: number
  dpr: number
}

type SignalPalette = Record<SignalKind, string> & {
  typing: string
  filament: string
  core: string
}

const fallbackPalette: SignalPalette = {
  user: 'hsl(166 78% 46%)',
  typing: 'hsl(209 96% 64%)',
  message: 'hsl(190 90% 55%)',
  thinking: 'hsl(270 86% 70%)',
  tool: 'hsl(38 96% 58%)',
  file: 'hsl(334 86% 65%)',
  attention: 'hsl(52 96% 62%)',
  success: 'hsl(151 74% 51%)',
  error: 'hsl(4 88% 66%)',
  ambient: 'hsl(215 26% 72%)',
  filament: 'hsl(166 62% 52%)',
  core: 'hsl(215 30% 94%)',
}

export function SignalField({ sessionID, events, active, running, thinking, streamState, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fieldRef = useRef(createSignalField(sessionID ?? 'waiting'))
  const pointerRef = useRef<SignalPointer | null>(null)
  const activeRef = useRef(active)
  const reducedMotionRef = useRef(false)
  const drawRef = useRef<() => void>(() => undefined)
  const trackedSessionRef = useRef<string | null | undefined>(undefined)
  const lastSequenceRef = useRef(0)
  const nextThinkingPulseAtRef = useRef(0)
  const [typingSessionID, setTypingSessionID] = useState<string | null>(null)
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    reducedMotionRef.current = reducedMotion
  }, [reducedMotion])

  useEffect(() => {
    if (trackedSessionRef.current !== sessionID) {
      trackedSessionRef.current = sessionID
      lastSequenceRef.current = latestSignalSequence(events)
      fieldRef.current = createSignalField(sessionID ?? 'waiting')
      pointerRef.current = null
      drawRef.current()
      return
    }

    if (streamState !== 'connected') {
      lastSequenceRef.current = latestSignalSequence(events)
      return
    }

    const batch = signalEventsAfter(events, lastSequenceRef.current)
    lastSequenceRef.current = batch.newestSeq
    if (!active || batch.events.length === 0) return
    applySignalImpulses(fieldRef.current, collapseSignalEvents(batch.events))
    drawRef.current()
  }, [active, events, sessionID, streamState])

  useEffect(() => {
    let typingTimer = 0
    const unsubscribe = subscribeComposerActivity((activity) => {
      if (!activeRef.current || activity.sessionID !== sessionID) return
      addTypingSignal(fieldRef.current, activity.intensity)
      setTypingSessionID(activity.sessionID)
      window.clearTimeout(typingTimer)
      typingTimer = window.setTimeout(() => setTypingSessionID(null), 1_100)
      if (reducedMotionRef.current) drawRef.current()
    })
    return () => {
      window.clearTimeout(typingTimer)
      unsubscribe()
    }
  }, [sessionID])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const fieldCanvas = canvas
    const fieldContext = context

    let size: CanvasSize = { width: 1, height: 1, dpr: 1 }
    let palette = readSignalPalette(fieldCanvas)
    let animationFrame = 0
    let animationTimer = 0
    let lastFrameAt = performance.now()
    let stopped = false

    if (thinking) {
      addThinkingPulse(fieldRef.current)
      nextThinkingPulseAtRef.current = performance.now() + 1_300
    } else {
      nextThinkingPulseAtRef.current = 0
    }

    function resize() {
      const bounds = fieldCanvas.getBoundingClientRect()
      const width = Math.max(1, bounds.width || fieldCanvas.clientWidth || 320)
      const height = Math.max(1, bounds.height || fieldCanvas.clientHeight || 360)
      const dpr = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1))
      const pixelWidth = Math.round(width * dpr)
      const pixelHeight = Math.round(height * dpr)
      if (fieldCanvas.width !== pixelWidth || fieldCanvas.height !== pixelHeight) {
        fieldCanvas.width = pixelWidth
        fieldCanvas.height = pixelHeight
      }
      size = { width, height, dpr }
      draw()
    }

    function draw() {
      drawSignalField(fieldContext, fieldRef.current, size, palette)
    }

    function cancelLoop() {
      window.clearTimeout(animationTimer)
      window.cancelAnimationFrame(animationFrame)
      animationTimer = 0
      animationFrame = 0
    }

    function queueFrame() {
      if (stopped || !active || reducedMotion || document.hidden || animationTimer || animationFrame) return
      const delay = fieldRef.current.energy > 0.035 || fieldRef.current.bursts.length > 0 ? 1000 / 30 : 1000 / 15
      animationTimer = window.setTimeout(() => {
        animationTimer = 0
        animationFrame = window.requestAnimationFrame(frame)
      }, delay)
    }

    function frame(now: number) {
      animationFrame = 0
      const elapsed = Math.min(0.08, Math.max(0, (now - lastFrameAt) / 1000))
      lastFrameAt = now
      if (thinking && now >= nextThinkingPulseAtRef.current) {
        addThinkingPulse(fieldRef.current)
        nextThinkingPulseAtRef.current = now + 1_300
      }
      stepSignalField(fieldRef.current, elapsed, pointerRef.current, thinking)
      draw()
      queueFrame()
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        cancelLoop()
        return
      }
      lastFrameAt = performance.now()
      draw()
      queueFrame()
    }

    function handleThemeChange() {
      palette = readSignalPalette(fieldCanvas)
      draw()
    }

    drawRef.current = draw
    resize()

    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    resizeObserver?.observe(fieldCanvas)
    if (!resizeObserver) window.addEventListener('resize', resize)
    const themeObserver = new MutationObserver(handleThemeChange)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    document.addEventListener('visibilitychange', handleVisibilityChange)

    if (!reducedMotion) queueFrame()
    else draw()

    return () => {
      stopped = true
      cancelLoop()
      resizeObserver?.disconnect()
      if (!resizeObserver) window.removeEventListener('resize', resize)
      themeObserver.disconnect()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (drawRef.current === draw) drawRef.current = () => undefined
    }
  }, [active, reducedMotion, running, sessionID, streamState, thinking])

  function updatePointer(event: PointerEvent<HTMLCanvasElement>) {
    if (event.pointerType === 'touch') return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    pointerRef.current = {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
      strength: 1,
    }
  }

  function ripple(event: PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    addSignalRipple(
      fieldRef.current,
      (event.clientX - bounds.left) / bounds.width,
      (event.clientY - bounds.top) / bounds.height,
    )
    drawRef.current()
  }

  const typing = active && typingSessionID === sessionID
  const status = signalFieldStatus(running, thinking, typing, streamState)
  const statusKind = signalFieldStatusKind(running, thinking, typing, streamState)
  return (
    <section
      aria-label="Signal field visualizer"
      className={cn(
        'flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-border/70 bg-background/46 shadow-sm',
        className,
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2 pt-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <Orbit className="size-3.5" aria-hidden="true" />
          <span>Signal field</span>
        </div>
        <span
          data-state={statusKind}
          className="signal-field-status text-[9px] font-semibold uppercase tracking-[0.13em] text-muted-foreground"
        >
          {status}
        </span>
      </div>
      <div className="signal-field-stage relative min-h-40 flex-1 overflow-hidden border-t border-border/45">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Ambient visualization of current session activity. ${status}.`}
          className="absolute inset-0 size-full touch-manipulation"
          onPointerMove={updatePointer}
          onPointerLeave={() => {
            pointerRef.current = null
          }}
          onPointerDown={ripple}
        />
      </div>
    </section>
  )
}

function drawSignalField(
  context: CanvasRenderingContext2D,
  field: SignalFieldState,
  size: CanvasSize,
  palette: SignalPalette,
) {
  const { width, height, dpr } = size
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.clearRect(0, 0, width, height)
  context.lineCap = 'round'
  context.lineJoin = 'round'

  drawFilaments(context, field, width, height, palette)
  drawCore(context, field, width, height, palette)
  for (const burst of field.bursts) {
    drawBurst(context, burst, width, height, burst.source === 'typing' ? palette.typing : palette[burst.kind])
  }
  drawMotes(context, field, width, height, palette)
  context.globalAlpha = 1
}

function drawFilaments(
  context: CanvasRenderingContext2D,
  field: SignalFieldState,
  width: number,
  height: number,
  palette: SignalPalette,
) {
  const threshold = Math.min(112, Math.max(76, Math.min(width, height) * 0.3))
  context.lineWidth = 0.68 + field.energy * 0.58 + field.reasoning * 0.3 + field.typing * 0.28
  for (let leftIndex = 0; leftIndex < field.motes.length; leftIndex += 1) {
    const left = field.motes[leftIndex]
    for (let rightIndex = leftIndex + 1; rightIndex < field.motes.length; rightIndex += 1) {
      const right = field.motes[rightIndex]
      const dx = (right.x - left.x) * width
      const dy = (right.y - left.y) * height
      const distance = Math.hypot(dx, dy)
      if (distance > threshold) continue
      const linkIndex = leftIndex + rightIndex
      context.strokeStyle =
        field.typing > 0.04 && linkIndex % 4 === 0
          ? palette.typing
          : field.reasoning > 0.04 && linkIndex % 3 === 0
            ? palette.thinking
            : palette.filament
      context.globalAlpha =
        (1 - distance / threshold) *
        (0.13 + field.energy * 0.23 + field.reasoning * 0.17 + field.typing * 0.2)
      context.beginPath()
      context.moveTo(left.x * width, left.y * height)
      context.lineTo(right.x * width, right.y * height)
      context.stroke()
    }
  }
}

function drawCore(
  context: CanvasRenderingContext2D,
  field: SignalFieldState,
  width: number,
  height: number,
  palette: SignalPalette,
) {
  const x = (0.5 + Math.sin(field.time * 0.17) * 0.09) * width
  const y = (0.5 + Math.cos(field.time * 0.13) * 0.075) * height
  const baseRadius = Math.min(width, height) * (0.082 + field.energy * 0.024 + field.typing * 0.01)
  const charge = Math.max(field.reasoning, field.typing * 0.82)
  if (charge > 0.01) {
    const glowRadius = baseRadius * (3.1 + charge * 0.7)
    const glow = context.createRadialGradient(x, y, 0, x, y, glowRadius)
    glow.addColorStop(0, field.reasoning >= field.typing ? palette.thinking : palette.typing)
    glow.addColorStop(1, 'transparent')
    context.fillStyle = glow
    context.globalAlpha = 0.06 + charge * 0.11
    context.beginPath()
    context.arc(x, y, glowRadius, 0, Math.PI * 2)
    context.fill()
  }
  context.strokeStyle = palette.filament
  for (let ring = 0; ring < 4; ring += 1) {
    const pulse = (Math.sin(field.time * (0.42 + ring * 0.05) + ring * 1.7) + 1) * 0.5
    const rotation = field.time * (ring % 2 === 0 ? 0.075 : -0.055)
    context.globalAlpha = 0.1 + pulse * 0.08 + field.energy * 0.11 + field.typing * 0.08
    context.lineWidth = ring === 0 ? 1.25 : 0.78
    context.beginPath()
    context.arc(x, y, baseRadius + ring * 9 + pulse * 4, -0.8 + ring + rotation, 3.7 + ring + rotation)
    context.stroke()
  }
  if (field.typing > 0.01) {
    context.strokeStyle = palette.typing
    for (let arc = 0; arc < 3; arc += 1) {
      const rotation = -Math.PI / 2 + Math.sin(field.time * 0.8 + arc * 1.8) * 0.55
      context.globalAlpha = field.typing * (0.18 + arc * 0.045)
      context.lineWidth = 0.9 + field.typing * 0.7
      context.beginPath()
      context.arc(x, y, baseRadius + 15 + arc * 12, rotation - 0.45, rotation + 0.45)
      context.stroke()
    }
  }
  if (field.reasoning > 0.01) {
    context.strokeStyle = palette.thinking
    for (let arc = 0; arc < 4; arc += 1) {
      const rotation = field.time * (arc % 2 === 0 ? 0.24 : -0.18) + arc * 2.1
      context.globalAlpha = field.reasoning * (0.2 + arc * 0.045)
      context.lineWidth = 0.9 + field.reasoning * 0.85
      context.beginPath()
      context.arc(x, y, baseRadius + 18 + arc * 13, rotation, rotation + 1.15 + field.reasoning * 0.7)
      context.stroke()
    }
  }
  context.fillStyle = palette.core
  context.globalAlpha = 0.52 + field.energy * 0.34
  context.beginPath()
  context.arc(x, y, 1.7 + field.energy * 2.1, 0, Math.PI * 2)
  context.fill()
}

function drawMotes(
  context: CanvasRenderingContext2D,
  field: SignalFieldState,
  width: number,
  height: number,
  palette: SignalPalette,
) {
  for (let index = 0; index < field.motes.length; index += 1) {
    const mote = field.motes[index]
    const x = mote.x * width
    const y = mote.y * height
    const color =
      field.reasoning > 0.12 && index % 3 === 0
        ? palette.thinking
        : index % 7 === 0
          ? palette.thinking
          : index % 5 === 0
            ? palette.message
            : palette.user
    const activityPulse =
      1 +
      field.reasoning * 0.22 * Math.sin(field.time * 1.05 + mote.phase) +
      field.typing * 0.15 * Math.sin(field.time * 1.6 + mote.phase)
    const radius = mote.radius * (0.88 + mote.depth * 0.52 + field.energy * 0.34) * activityPulse
    context.fillStyle = color
    context.globalAlpha = 0.07 + mote.depth * 0.075 + field.energy * 0.06
    context.beginPath()
    context.arc(x, y, radius * 4.2, 0, Math.PI * 2)
    context.fill()
    context.globalAlpha = 0.5 + mote.depth * 0.38
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fill()
  }
}

function drawBurst(
  context: CanvasRenderingContext2D,
  burst: SignalBurst,
  width: number,
  height: number,
  color: string,
) {
  const progress = Math.min(1, burst.age / burst.lifetime)
  const fadePower = burst.source === 'typing' ? 1.05 : burst.source === 'thinking' ? 1.2 : 1.35
  const fade = Math.pow(1 - progress, fadePower)
  const x = burst.x * width
  const y = burst.y * height
  const scaleBase = burst.source === 'typing' ? 0.026 : 0.042
  const scaleTravel = burst.source === 'typing' ? 0.135 : 0.23
  const scale = Math.min(width, height) * (scaleBase + progress * scaleTravel) * (0.75 + burst.strength * 0.25)
  context.save()
  context.strokeStyle = color
  context.fillStyle = color
  context.lineWidth = 0.95 + burst.strength * 0.52
  context.globalAlpha = fade * Math.min(0.92, 0.38 + burst.strength * 0.27)

  switch (burst.kind) {
    case 'user':
      if (burst.source === 'typing') drawTypingBurst(context, burst, x, y, scale, progress)
      else drawRingBurst(context, burst, x, y, scale, progress)
      break
    case 'message':
    case 'success':
    case 'error':
      drawRingBurst(context, burst, x, y, scale, progress)
      break
    case 'thinking':
      drawThinkingBurst(context, burst, x, y, scale, progress)
      break
    case 'tool':
      drawPolygonBurst(context, burst, x, y, scale, progress)
      break
    case 'file':
      drawFileBurst(context, burst, x, y, scale, progress)
      break
    case 'attention':
      drawAttentionBurst(context, burst, x, y, scale, progress)
      break
    case 'ambient':
      drawAmbientBurst(context, burst, x, y, scale, progress)
      break
  }
  context.restore()
}

function drawRingBurst(
  context: CanvasRenderingContext2D,
  burst: SignalBurst,
  x: number,
  y: number,
  scale: number,
  progress: number,
) {
  const sides = burst.kind === 'error' ? 7 : burst.kind === 'success' ? 12 : 0
  const alpha = context.globalAlpha
  for (let ring = 0; ring < Math.min(3, Math.ceil(burst.strength + 0.7)); ring += 1) {
    const radius = scale * (0.46 + ring * 0.22)
    context.globalAlpha = alpha * (1 - ring * 0.24)
    context.beginPath()
    if (sides > 0) tracePolygon(context, x, y, radius, sides, burst.rotation + progress * burst.spin)
    else context.arc(x, y, radius, 0, Math.PI * 2)
    context.stroke()
  }
  context.globalAlpha = alpha
  drawRadialPieces(context, burst, x, y, scale, progress, burst.kind === 'success' ? 'dot' : 'dash')
}

function drawTypingBurst(
  context: CanvasRenderingContext2D,
  burst: SignalBurst,
  x: number,
  y: number,
  scale: number,
  progress: number,
) {
  const alpha = context.globalAlpha
  for (let index = 0; index < burst.pieces; index += 1) {
    const jitter = (seededValue(burst.seed, index + 19) - 0.5) * 0.55
    const angle = burst.rotation + index * 2.399 + jitter + progress * burst.spin
    const reach = scale * (0.32 + seededValue(burst.seed, index + 47) * 0.72)
    const px = x + Math.cos(angle) * reach
    const py = y + Math.sin(angle) * reach
    const particleSize = 1.15 + seededValue(burst.seed, index + 83) * 2.05
    context.globalAlpha = alpha * (0.58 + seededValue(burst.seed, index + 101) * 0.38)
    context.lineWidth = 0.7 + burst.strength * 0.28
    context.beginPath()
    if (index % 3 === 0) {
      tracePolygon(context, px, py, particleSize, index % 2 === 0 ? 4 : 3, angle + progress)
      context.stroke()
    } else if (index % 3 === 1) {
      context.arc(px, py, particleSize * 0.52, 0, Math.PI * 2)
      context.fill()
    } else {
      const trail = 2.5 + burst.strength * 1.8
      context.moveTo(px - Math.cos(angle) * trail, py - Math.sin(angle) * trail)
      context.lineTo(px + Math.cos(angle) * trail, py + Math.sin(angle) * trail)
      context.stroke()
    }
  }
}

function drawThinkingBurst(
  context: CanvasRenderingContext2D,
  burst: SignalBurst,
  x: number,
  y: number,
  scale: number,
  progress: number,
) {
  const alpha = context.globalAlpha
  const contours = 4
  const steps = 52
  const seedPhase = seededValue(burst.seed, 211) * Math.PI * 2
  const drift = progress * 1.15 + burst.spin * 0.7
  context.save()
  context.translate(x, y)
  context.rotate(burst.rotation * 0.18 + progress * burst.spin * 0.35)
  context.scale(1, 0.8)

  for (let contour = 0; contour < contours; contour += 1) {
    const baseRadius = scale * (0.2 + contour * 0.17)
    const contourPhase = seedPhase + contour * 0.72
    context.globalAlpha = alpha * (0.86 - contour * 0.11)
    context.lineWidth = 0.78 + burst.strength * 0.36 - contour * 0.06
    context.beginPath()
    for (let step = 0; step <= steps; step += 1) {
      const angle = (step / steps) * Math.PI * 2
      const harmonicA = Math.sin(angle * 3 + contourPhase + drift) * 0.095
      const harmonicB = Math.sin(angle * 5 - contourPhase * 0.65 - drift * 0.8) * 0.052
      const harmonicC = Math.cos(angle * 2 + contour * 1.1 + drift * 0.45) * 0.035
      const radius = baseRadius * (1 + harmonicA + harmonicB + harmonicC)
      const px = Math.cos(angle) * radius
      const py = Math.sin(angle) * radius
      if (step === 0) context.moveTo(px, py)
      else context.lineTo(px, py)
    }
    context.closePath()
    context.stroke()
  }

  context.globalAlpha = alpha * 0.64
  for (let particle = 0; particle < 9; particle += 1) {
    const contour = particle % contours
    const baseRadius = scale * (0.2 + contour * 0.17)
    const contourPhase = seedPhase + contour * 0.72
    const direction = particle % 2 === 0 ? 1 : -1
    const angle = seededValue(burst.seed, particle + 41) * Math.PI * 2 + drift * (0.42 + contour * 0.05) * direction
    const harmonicA = Math.sin(angle * 3 + contourPhase + drift) * 0.095
    const harmonicB = Math.sin(angle * 5 - contourPhase * 0.65 - drift * 0.8) * 0.052
    const harmonicC = Math.cos(angle * 2 + contour * 1.1 + drift * 0.45) * 0.035
    const radius = baseRadius * (1 + harmonicA + harmonicB + harmonicC)
    context.beginPath()
    context.arc(
      Math.cos(angle) * radius,
      Math.sin(angle) * radius,
      0.7 + seededValue(burst.seed, particle + 151) * 1.15,
      0,
      Math.PI * 2,
    )
    context.fill()
  }

  context.globalAlpha = alpha * 0.82
  context.beginPath()
  context.ellipse(0, 0, scale * 0.075, scale * 0.052, -progress * 0.28, 0, Math.PI * 2)
  context.fill()
  context.restore()
}

function drawPolygonBurst(
  context: CanvasRenderingContext2D,
  burst: SignalBurst,
  x: number,
  y: number,
  scale: number,
  progress: number,
) {
  for (let index = 0; index < burst.pieces; index += 1) {
    const angle = burst.rotation + index * ((Math.PI * 2) / burst.pieces) + progress * burst.spin
    const distance = scale * (0.35 + seededValue(burst.seed, index) * 0.7)
    const px = x + Math.cos(angle) * distance
    const py = y + Math.sin(angle) * distance
    context.beginPath()
    tracePolygon(context, px, py, 2.5 + burst.strength * 1.2, index % 2 === 0 ? 4 : 6, angle)
    context.stroke()
  }
}

function drawFileBurst(
  context: CanvasRenderingContext2D,
  burst: SignalBurst,
  x: number,
  y: number,
  scale: number,
  progress: number,
) {
  for (let index = 0; index < burst.pieces; index += 1) {
    const angle = burst.rotation + index * 2.399 + progress * burst.spin
    const distance = scale * (0.2 + seededValue(burst.seed, index) * 0.82)
    const side = 3 + seededValue(burst.seed, index + 23) * 5
    context.save()
    context.translate(x + Math.cos(angle) * distance, y + Math.sin(angle) * distance)
    context.rotate(angle + progress)
    context.strokeRect(-side * 0.75, -side * 0.42, side * 1.5, side * 0.84)
    context.restore()
  }
}

function drawAttentionBurst(
  context: CanvasRenderingContext2D,
  burst: SignalBurst,
  x: number,
  y: number,
  scale: number,
  progress: number,
) {
  context.beginPath()
  context.ellipse(x, y, scale * 0.72, scale * 0.28, burst.rotation + progress * 0.35, 0, Math.PI * 2)
  context.stroke()
  for (let index = 0; index < 3; index += 1) {
    const angle = burst.rotation + progress * 2.2 + index * ((Math.PI * 2) / 3)
    context.beginPath()
    context.arc(x + Math.cos(angle) * scale * 0.68, y + Math.sin(angle) * scale * 0.26, 1.8, 0, Math.PI * 2)
    context.fill()
  }
}

function drawAmbientBurst(
  context: CanvasRenderingContext2D,
  burst: SignalBurst,
  x: number,
  y: number,
  scale: number,
  progress: number,
) {
  drawRadialPieces(context, burst, x, y, scale * 0.72, progress, 'dash')
}

function drawRadialPieces(
  context: CanvasRenderingContext2D,
  burst: SignalBurst,
  x: number,
  y: number,
  scale: number,
  progress: number,
  shape: 'dash' | 'dot',
) {
  for (let index = 0; index < burst.pieces; index += 1) {
    const angle = burst.rotation + index * ((Math.PI * 2) / burst.pieces) + progress * burst.spin
    const distance = scale * (0.55 + seededValue(burst.seed, index) * 0.58)
    const px = x + Math.cos(angle) * distance
    const py = y + Math.sin(angle) * distance
    context.beginPath()
    if (shape === 'dot') {
      context.arc(px, py, 1.4 + burst.strength * 0.35, 0, Math.PI * 2)
      context.fill()
    } else {
      context.moveTo(px, py)
      context.lineTo(px + Math.cos(angle) * (4 + burst.strength * 2), py + Math.sin(angle) * (4 + burst.strength * 2))
      context.stroke()
    }
  }
}

function tracePolygon(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  sides: number,
  rotation: number,
) {
  for (let side = 0; side < sides; side += 1) {
    const angle = rotation + side * ((Math.PI * 2) / sides)
    const px = x + Math.cos(angle) * radius
    const py = y + Math.sin(angle) * radius
    if (side === 0) context.moveTo(px, py)
    else context.lineTo(px, py)
  }
  context.closePath()
}

function seededValue(seed: number, offset: number) {
  const value = Math.sin(seed * 0.0001 + offset * 91.733) * 43758.5453
  return value - Math.floor(value)
}

function readSignalPalette(element: HTMLElement): SignalPalette {
  const styles = window.getComputedStyle(element)
  return {
    user: cssHSL(styles, '--signal-user', fallbackPalette.user),
    typing: cssHSL(styles, '--signal-typing', fallbackPalette.typing),
    message: cssHSL(styles, '--signal-message', fallbackPalette.message),
    thinking: cssHSL(styles, '--signal-thinking', fallbackPalette.thinking),
    tool: cssHSL(styles, '--signal-tool', fallbackPalette.tool),
    file: cssHSL(styles, '--signal-file', fallbackPalette.file),
    attention: cssHSL(styles, '--signal-attention', fallbackPalette.attention),
    success: cssHSL(styles, '--signal-success', fallbackPalette.success),
    error: cssHSL(styles, '--signal-error', fallbackPalette.error),
    ambient: cssHSL(styles, '--signal-ambient', fallbackPalette.ambient),
    filament: cssHSL(styles, '--signal-filament', fallbackPalette.filament),
    core: cssHSL(styles, '--signal-core', fallbackPalette.core),
  }
}

function cssHSL(styles: CSSStyleDeclaration, name: string, fallback: string) {
  const value = styles.getPropertyValue(name).trim()
  return value ? `hsl(${value})` : fallback
}

function signalFieldStatus(running: boolean, thinking: boolean, typing: boolean, streamState: StreamState) {
  if (streamState === 'disconnected') return 'Offline'
  if (streamState === 'reconnecting') return 'Reconnecting'
  if (streamState === 'loading') return 'Tuning'
  if (typing) return 'Typing'
  if (thinking) return 'Thinking'
  return running ? 'Live' : 'Quiet'
}

function signalFieldStatusKind(running: boolean, thinking: boolean, typing: boolean, streamState: StreamState) {
  if (streamState === 'disconnected') return 'offline'
  if (streamState === 'reconnecting') return 'reconnecting'
  if (streamState === 'loading') return 'tuning'
  if (typing) return 'typing'
  if (thinking) return 'thinking'
  return running ? 'live' : 'quiet'
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!media) return
    const update = () => setReduced(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return reduced
}
