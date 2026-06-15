import type { AgentEvent, SessionStatus, UserInputQuestion } from '@/lib/api'

export const knownEventTypes = [
  'user.message.completed',
  'user.action.completed',
  'session.action.completed',
  'session.status.updated',
  'agent.run.started',
  'agent.status.started',
  'agent.message.delta',
  'agent.message.completed',
  'agent.plan.delta',
  'agent.plan.completed',
  'agent.thinking.delta',
  'agent.thinking.completed',
  'agent.log.delta',
  'agent.input.requested',
  'agent.input.answered',
  'tool.call.started',
  'tool.call.delta',
  'tool.call.completed',
  'file.change.started',
  'file.change.delta',
  'file.change.completed',
  'provider.codex.event',
  'provider.codex.request',
  'provider.codex.parse_error',
  'agent.run.completed',
  'agent.run.failed',
  'agent.run.cancelled',
] as const

export type DisplayEvent = AgentEvent & {
  display_type?: string
}

export type EventGroupKind =
  | 'user-message'
  | 'action-break'
  | 'agent-message'
  | 'plan'
  | 'thinking'
  | 'tool-call'
  | 'file-change'
  | 'log'
  | 'error'
  | 'terminal'
  | 'unknown'

export type EventGroup = {
  id: string
  kind: EventGroupKind
  label: string
  status: string
  startSeq: number
  endSeq: number
  events: AgentEvent[]
  text: string
  error: string
  paths: string[]
  defaultOpen: boolean
  terminal: boolean
}

export type ChatTranscriptTool = {
  id: string
  kind: Extract<EventGroupKind, 'tool-call' | 'file-change'>
  label: string
  status: string
  text: string
  error: string
  paths: string[]
  startSeq: number
  endSeq: number
}

export type ChatTranscriptAttachment = {
  name: string
  mediaType: string
  dataURL: string
  sizeBytes: number
}

export type ChatTranscriptMessage = {
  id: string
  role: 'user' | 'assistant'
  label: string
  variant: 'default' | 'plan'
  text: string
  attachments: ChatTranscriptAttachment[]
  status: string
  createdAt: string
  tools: ChatTranscriptTool[]
  streaming: boolean
  startSeq: number
  endSeq: number
}

export type ChatDebugEvent = {
  id: string
  label: string
  status: string
  startSeq: number
  endSeq: number
  eventCount: number
  text: string
  error: string
  payload: unknown
  createdAt: string
}

export type ChatActionBreak = {
  id: string
  action: string
  label: string
  createdAt: string
  startSeq: number
  endSeq: number
}

export type ChatTimelineItem =
  | {
      kind: 'message'
      id: string
      startSeq: number
      endSeq: number
      message: ChatTranscriptMessage
    }
  | {
      kind: 'debug'
      id: string
      startSeq: number
      endSeq: number
      event: ChatDebugEvent
    }
  | {
      kind: 'action'
      id: string
      startSeq: number
      endSeq: number
      action: ChatActionBreak
    }

export type PendingUserInputRequest = {
  requestID: string
  provider: string
  providerEventType: string
  threadID: string
  turnID: string
  itemID: string
  questions: UserInputQuestion[]
  createdAt: string
  seq: number
}

export type TokenUsageSnapshot = {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export type TokenUsageSummary = {
  total: TokenUsageSnapshot
  last: TokenUsageSnapshot
  modelContextWindow: number
  updatedAt: string
  seq: number
}

export function appendEvent(events: AgentEvent[], event: AgentEvent) {
  if (events.some((existing) => existing.seq === event.seq)) {
    return events
  }
  return [...events, event].sort((left, right) => left.seq - right.seq)
}

export function appendEvents(events: AgentEvent[], nextEvents: AgentEvent[]) {
  return nextEvents.reduce(appendEvent, events)
}

export function lastSeq(events: AgentEvent[]) {
  return events.reduce((max, event) => Math.max(max, event.seq), 0)
}

export function coalesceDisplayEvents(events: AgentEvent[]) {
  const displayEvents: DisplayEvent[] = []

  for (const event of events) {
    const previous = displayEvents[displayEvents.length - 1]
    if (event.type === 'agent.message.delta' && previous?.type === 'agent.message.delta') {
      previous.payload = {
        text: `${payloadText(previous.payload)}${payloadText(event.payload)}`,
      }
      previous.seq = event.seq
      previous.id = event.id
      previous.created_at = event.created_at
      continue
    }
    displayEvents.push({ ...event })
  }

  return displayEvents
}

export function groupEvents(events: AgentEvent[]) {
  const groups: EventGroup[] = []
  const toolGroupsByID = new Map<string, EventGroup>()

  for (const event of sortedUniqueEvents(events)) {
    const previous = groups[groups.length - 1]
    const toolID = toolGroupID(event)

    if (
      event.type === 'agent.message.delta' &&
      previous?.kind === 'agent-message' &&
      previous.events[previous.events.length - 1]?.type === 'agent.message.delta' &&
      previous.events[previous.events.length - 1]?.session_id === event.session_id
    ) {
      appendToGroup(previous, event)
      continue
    }

    if (
      isPlanDeltaEvent(event) &&
      previous?.kind === 'plan' &&
      previous.events[previous.events.length - 1] &&
      isPlanDeltaEvent(previous.events[previous.events.length - 1])
    ) {
      appendToGroup(previous, event)
      continue
    }

    if (
      event.type === 'agent.thinking.delta' &&
      previous?.kind === 'thinking' &&
      previous.events[previous.events.length - 1]?.type === 'agent.thinking.delta'
    ) {
      appendToGroup(previous, event)
      continue
    }

    if (event.type === 'agent.log.delta' && previous?.kind === 'log') {
      appendToGroup(previous, event)
      continue
    }

    if (event.type.startsWith('tool.call')) {
      const toolGroup = toolID ? toolGroupsByID.get(toolID) : nearbyToolGroup(previous, event)
      if (toolGroup) {
        appendToGroup(toolGroup, event)
        continue
      }

      const group = newGroup(event)
      groups.push(group)
      if (toolID) {
        toolGroupsByID.set(toolID, group)
      }
      continue
    }

    if (event.type.startsWith('file.change') && previous?.kind === 'file-change' && event.seq - previous.endSeq <= 2) {
      appendToGroup(previous, event)
      continue
    }

    groups.push(newGroup(event))
  }

  return groups
}

export function buildChatTranscript(events: AgentEvent[]) {
  return buildChatTimeline(events, false).flatMap((item) => (item.kind === 'message' ? [item.message] : []))
}

export function buildChatTimeline(events: AgentEvent[], includeDebugEvents: boolean) {
  const items: ChatTimelineItem[] = []
  const messages: ChatTranscriptMessage[] = []
  let currentAssistant: ChatTranscriptMessage | null = null
  const assistantMessagesByItemID = new Map<string, ChatTranscriptMessage>()

  for (const group of groupEvents(events)) {
    if (group.kind === 'action-break') {
      currentAssistant = null
      items.push({
        kind: 'action',
        id: `action-${group.id}`,
        startSeq: group.startSeq,
        endSeq: group.endSeq,
        action: chatActionFromGroup(group),
      })
      continue
    }

    if (group.kind === 'user-message') {
      const message = chatMessageFromGroup('user', group)
      messages.push(message)
      syncMessageTimelineItem(items, message)
      currentAssistant = null
      continue
    }

    if (group.kind === 'agent-message' || group.kind === 'plan') {
      currentAssistant = assistantMessageForGroup(messages, currentAssistant, assistantMessagesByItemID, group)
      mergeAssistantMessage(currentAssistant, group)
      syncMessageTimelineItem(items, currentAssistant)
      continue
    }

    if (group.kind === 'tool-call' || group.kind === 'file-change') {
      currentAssistant = ensureAssistantMessage(messages, currentAssistant, group)
      currentAssistant.tools.push(chatToolFromGroup(group))
      currentAssistant.streaming = group.status !== 'completed'
      updateMessageRange(currentAssistant, group)
      syncMessageTimelineItem(items, currentAssistant)
      continue
    }

    if (group.kind === 'error') {
      currentAssistant = ensureAssistantMessage(messages, currentAssistant, group)
      currentAssistant.text = mergeChatText(currentAssistant.text, group.error || group.text || group.label)
      currentAssistant.status = 'failed'
      currentAssistant.streaming = false
      updateMessageRange(currentAssistant, group)
      syncMessageTimelineItem(items, currentAssistant)
      continue
    }

    if (includeDebugEvents && isHiddenDebugGroup(group)) {
      items.push({
        kind: 'debug',
        id: `debug-${group.id}`,
        startSeq: group.startSeq,
        endSeq: group.endSeq,
        event: chatDebugEventFromGroup(group),
      })
    }
  }

  return items.filter((item) => {
    if (item.kind === 'debug' || item.kind === 'action') {
      return true
    }
    return item.message.text.trim() || item.message.tools.length > 0
  })
}

export function pendingUserInputRequest(events: AgentEvent[]) {
  const requests = new Map<string, PendingUserInputRequest>()
  const answered = new Set<string>()
  let latestTerminalSeq = 0

  for (const event of sortedUniqueEvents(events)) {
    if (isTerminalEvent(event.type)) {
      latestTerminalSeq = event.seq
    }
    if (event.type === 'agent.input.requested') {
      const request = userInputRequestFromEvent(event)
      if (request) {
        requests.set(request.requestID, request)
      }
    }
    if (event.type === 'agent.input.answered') {
      const requestID = payloadString(event.payload, ['request_id'])
      if (requestID) {
        answered.add(requestID)
      }
    }
  }

  return (
    [...requests.values()]
      .filter((request) => request.seq > latestTerminalSeq && !answered.has(request.requestID))
      .sort((left, right) => right.seq - left.seq)[0] ?? null
  )
}

export function latestTokenUsage(events: AgentEvent[]) {
  let latest: TokenUsageSummary | null = null
  for (const event of sortedUniqueEvents(events)) {
    const summary = tokenUsageFromEvent(event)
    if (summary) {
      latest = summary
    }
  }
  return latest
}

export function activeThinking(events: AgentEvent[]) {
  let activeGenericThinking = false
  const activeThinkingItems = new Set<string>()

  for (const event of sortedUniqueEvents(events)) {
    if (event.type === 'agent.status.started') {
      activeGenericThinking = true
      continue
    }

    if (event.type === 'agent.thinking.delta') {
      const itemID = payloadItemID(event.payload)
      if (itemID) {
        activeThinkingItems.add(itemID)
      } else {
        activeGenericThinking = true
      }
      continue
    }

    if (event.type === 'agent.thinking.completed') {
      const itemID = payloadItemID(event.payload)
      if (itemID) {
        activeThinkingItems.delete(itemID)
      }
      activeGenericThinking = false
      continue
    }

    if (clearsActiveThinking(event)) {
      activeGenericThinking = false
      activeThinkingItems.clear()
    }
  }

  return activeGenericThinking || activeThinkingItems.size > 0
}

export function eventLabel(eventOrType: AgentEvent | string) {
  const type = typeof eventOrType === 'string' ? eventOrType : eventOrType.type
  const providerEventType =
    typeof eventOrType === 'string' ? '' : payloadString(eventOrType.payload, ['provider_event_type'])
  if (typeof eventOrType !== 'string' && isPlanEvent(eventOrType)) return 'Plan'
  if (typeof eventOrType !== 'string' && isActionBreakEvent(eventOrType)) return actionBreakLabel(eventOrType)
  if (providerEventType && type.startsWith('provider.')) return providerEventType
  if (type === 'session.status.updated') return 'Session status'
  if (type.startsWith('session.action') || type.startsWith('user.action')) return 'Session action'
  if (type.startsWith('user.message')) return 'User message'
  if (type.startsWith('agent.message')) return 'Agent message'
  if (type.startsWith('agent.plan')) return 'Plan'
  if (type.startsWith('agent.thinking')) return 'Thinking'
  if (type.startsWith('tool.call')) return 'Tool call'
  if (type.startsWith('file.change')) return 'File change'
  if (type === 'agent.log.delta') return 'Log'
  if (type.includes('failed') || type.includes('parse_error')) return 'Error'
  if (type === 'agent.run.completed') return 'Completed'
  if (type === 'agent.run.cancelled') return 'Cancelled'
  return type
}

export function payloadText(payload: unknown) {
  if (isRecord(payload)) {
    const value =
      payload.text ??
      payload.delta ??
      payload.output ??
      payload.aggregated_output ??
      payload.command ??
      payload.error ??
      payload.summary ??
      payload.message
    if (typeof value === 'string') {
      return value
    }
  }
  return ''
}

export function payloadError(payload: unknown) {
  if (!isRecord(payload)) {
    return ''
  }
  const value = payload.error ?? payload.message
  return typeof value === 'string' ? value : ''
}

function groupText(event: AgentEvent, kind: EventGroupKind) {
  if (kind === 'plan') {
    return planText(event)
  }
  return payloadText(event.payload)
}

function planText(event: AgentEvent) {
  const direct = payloadText(event.payload)
  if (direct) {
    return direct
  }
  const raw = legacyProviderRaw(event)
  if (!raw) {
    return ''
  }
  const delta = payloadLiteralString(raw, ['delta'])
  if (delta) {
    return delta
  }
  return isRecord(raw.item) ? payloadLiteralString(raw.item, ['text']) : ''
}

function isPlanEvent(event: AgentEvent) {
  return event.type.startsWith('agent.plan') || isLegacyProviderPlanEvent(event)
}

function isPlanDeltaEvent(event: AgentEvent) {
  return event.type === 'agent.plan.delta' || legacyProviderPlanKind(event) === 'delta'
}

function isLegacyProviderPlanEvent(event: AgentEvent) {
  return legacyProviderPlanKind(event) !== ''
}

function legacyProviderPlanKind(event: AgentEvent) {
  if (event.type !== 'provider.codex.event') {
    return ''
  }
  const providerEventType = payloadString(event.payload, ['provider_event_type'])
  if (providerEventType === 'item/plan/delta') {
    return 'delta'
  }
  if (providerEventType !== 'item/completed') {
    return ''
  }
  const raw = legacyProviderRaw(event)
  if (!raw || !isRecord(raw.item)) {
    return ''
  }
  return payloadString(raw.item, ['type']) === 'plan' ? 'completed' : ''
}

function legacyProviderRaw(event: AgentEvent) {
  if (!isRecord(event.payload) || !isRecord(event.payload.raw)) {
    return null
  }
  return event.payload.raw
}

function planItemID(event: AgentEvent | undefined) {
  if (!event) {
    return ''
  }
  const direct = payloadItemID(event.payload)
  if (direct) {
    return direct
  }
  const raw = legacyProviderRaw(event)
  if (!raw) {
    return ''
  }
  const itemID = payloadString(raw, ['itemId'])
  if (itemID) {
    return itemID
  }
  return isRecord(raw.item) ? payloadString(raw.item, ['id']) : ''
}

export function statusFromEvent(eventOrType: AgentEvent | string): SessionStatus | null {
  const type = typeof eventOrType === 'string' ? eventOrType : eventOrType.type
  if (type === 'session.status.updated' && typeof eventOrType !== 'string') {
    return payloadSessionStatus(eventOrType.payload)
  }

  switch (type) {
    case 'agent.run.started':
      return 'running'
    case 'agent.run.completed':
      return 'idle'
    case 'agent.run.failed':
      return 'failed'
    case 'agent.run.cancelled':
      return 'idle'
    default:
      return null
  }
}

function payloadSessionStatus(payload: unknown) {
  if (!isRecord(payload)) {
    return null
  }
  const status = payload.status
  return isSessionStatus(status) ? status : null
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return value === 'idle' || value === 'running' || value === 'failed'
}

export function isTerminalEvent(type: string) {
  return type === 'agent.run.completed' || type === 'agent.run.failed' || type === 'agent.run.cancelled'
}

export function isErrorEvent(type: string, status: string) {
  return status === 'failed' || type === 'provider.codex.parse_error' || type === 'agent.run.failed'
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortedUniqueEvents(events: AgentEvent[]) {
  const bySeq = new Map<number, AgentEvent>()
  for (const event of events) {
    if (!bySeq.has(event.seq)) {
      bySeq.set(event.seq, event)
    }
  }
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq)
}

function newGroup(event: AgentEvent): EventGroup {
  const kind = groupKind(event)
  const group: EventGroup = {
    id: groupID(event),
    kind,
    label: groupLabel(event, kind),
    status: event.status,
    startSeq: event.seq,
    endSeq: event.seq,
    events: [event],
    text: groupText(event, kind),
    error: payloadError(event.payload),
    paths: payloadPaths(event.payload),
    defaultOpen: defaultOpen(kind, event),
    terminal: isTerminalEvent(event.type),
  }
  return group
}

function appendToGroup(group: EventGroup, event: AgentEvent) {
  group.events.push(event)
  group.endSeq = event.seq
  group.status = event.status
  group.text = joinGroupText(group.text, groupText(event, group.kind))
  group.error = group.error || payloadError(event.payload)
  group.paths = uniqueStrings([...group.paths, ...payloadPaths(event.payload)])
  if (group.kind === 'tool-call') {
    group.label = toolLabelFromEvents(group.events)
  }
  if (group.kind === 'file-change') {
    group.label = fileChangeLabel(group)
  }
  group.defaultOpen =
    group.events.some((item) => isErrorEvent(item.type, item.status)) || defaultOpen(group.kind, event)
  group.terminal = group.terminal || isTerminalEvent(event.type)
}

function groupKind(event: AgentEvent): EventGroupKind {
  if (isErrorEvent(event.type, event.status)) return 'error'
  if (isActionBreakEvent(event)) return 'action-break'
  if (event.type === 'user.message.completed') return 'user-message'
  if (event.type.startsWith('agent.message')) return 'agent-message'
  if (isPlanEvent(event)) return 'plan'
  if (event.type.startsWith('agent.thinking')) return 'thinking'
  if (event.type.startsWith('tool.call')) return 'tool-call'
  if (event.type.startsWith('file.change')) return 'file-change'
  if (event.type === 'agent.log.delta') return 'log'
  if (isTerminalEvent(event.type)) return 'terminal'
  return 'unknown'
}

function groupLabel(event: AgentEvent, kind: EventGroupKind) {
  if (kind === 'tool-call') {
    return toolLabelFromEvents([event])
  }
  if (kind === 'file-change') {
    return fileChangeLabel({
      id: `${kind}-${event.seq}`,
      kind,
      label: eventLabel(event),
      status: event.status,
      startSeq: event.seq,
      endSeq: event.seq,
      events: [event],
      text: payloadText(event.payload),
      error: payloadError(event.payload),
      paths: payloadPaths(event.payload),
      defaultOpen: defaultOpen(kind, event),
      terminal: isTerminalEvent(event.type),
    })
  }
  return eventLabel(event)
}

function groupID(event: AgentEvent) {
  if (event.type.startsWith('tool.call')) {
    const toolID = toolGroupID(event)
    if (toolID) return `tool-${toolID}`
  }
  if (isPlanEvent(event)) {
    const planID = planItemID(event)
    if (planID) return `plan-${planID}`
  }
  return `${groupKind(event)}-${event.seq}`
}

function toolGroupID(event: AgentEvent) {
  if (!event.type.startsWith('tool.call')) {
    return ''
  }
  return payloadString(event.payload, ['tool_call_id', 'call_id', 'item_id', 'process_id', 'tool_id', 'id'])
}

function payloadItemID(payload: unknown) {
  return payloadString(payload, ['item_id', 'itemId', 'id'])
}

function clearsActiveThinking(event: AgentEvent) {
  return (
    event.type.startsWith('agent.message') ||
    event.type.startsWith('agent.plan') ||
    isLegacyProviderPlanEvent(event) ||
    event.type.startsWith('tool.call') ||
    event.type.startsWith('file.change') ||
    event.type === 'agent.input.requested' ||
    isTerminalEvent(event.type)
  )
}

function nearbyToolGroup(previous: EventGroup | undefined, event: AgentEvent) {
  if (!previous || previous.kind !== 'tool-call') {
    return null
  }
  if (event.seq - previous.endSeq > 2) {
    return null
  }
  return previous
}

function chatMessageFromGroup(role: ChatTranscriptMessage['role'], group: EventGroup): ChatTranscriptMessage {
  return {
    id: `chat-${role}-${group.startSeq}`,
    role,
    label: messageLabel(role, group.kind),
    variant: messageVariant(role, group.kind),
    text: group.text,
    attachments: chatAttachmentsFromGroup(group),
    status: group.status,
    createdAt: group.events[0]?.created_at ?? '',
    tools: [],
    streaming: group.status === 'delta' || group.status === 'started',
    startSeq: group.startSeq,
    endSeq: group.endSeq,
  }
}

function chatActionFromGroup(group: EventGroup): ChatActionBreak {
  const event = group.events[0]
  const action = event ? payloadString(event.payload, ['action']) : ''
  return {
    id: `action-${group.startSeq}`,
    action,
    label: event ? actionBreakLabel(event) : group.label,
    createdAt: event?.created_at ?? '',
    startSeq: group.startSeq,
    endSeq: group.endSeq,
  }
}

function isActionBreakEvent(event: AgentEvent) {
  return event.type === 'session.action.completed' || event.type === 'user.action.completed'
}

function actionBreakLabel(event: AgentEvent) {
  const action = payloadString(event.payload, ['action']).trim().toLowerCase()
  switch (action) {
    case 'clear':
      return 'CONVERSATION CLEARED'
    case 'compact':
      return 'CONVERSATION COMPACTED'
    default:
      return payloadString(event.payload, ['label']) || 'SESSION ACTION'
  }
}

function messageLabel(role: ChatTranscriptMessage['role'], kind: EventGroupKind) {
  if (role === 'user') {
    return 'You'
  }
  if (kind === 'plan') {
    return 'Plan'
  }
  return 'Assistant'
}

function messageVariant(role: ChatTranscriptMessage['role'], kind: EventGroupKind): ChatTranscriptMessage['variant'] {
  return role === 'assistant' && kind === 'plan' ? 'plan' : 'default'
}

function chatAttachmentsFromGroup(group: EventGroup): ChatTranscriptAttachment[] {
  if (group.kind !== 'user-message') {
    return []
  }
  const payload = group.events[0]?.payload
  if (!isRecord(payload) || !Array.isArray(payload.attachments)) {
    return []
  }
  return payload.attachments.flatMap((attachment): ChatTranscriptAttachment[] => {
    if (!isRecord(attachment)) {
      return []
    }
    const name = typeof attachment.name === 'string' ? attachment.name : 'image'
    const mediaType = typeof attachment.media_type === 'string' ? attachment.media_type : ''
    const dataURL = typeof attachment.data_url === 'string' ? attachment.data_url : ''
    const sizeBytes = typeof attachment.size_bytes === 'number' ? attachment.size_bytes : 0
    if (!mediaType.startsWith('image/') || !dataURL) {
      return []
    }
    return [{ name, mediaType, dataURL, sizeBytes }]
  })
}

function ensureAssistantMessage(
  messages: ChatTranscriptMessage[],
  currentAssistant: ChatTranscriptMessage | null,
  group: EventGroup,
) {
  if (currentAssistant) {
    return currentAssistant
  }

  const message = chatMessageFromGroup('assistant', group)
  message.text = ''
  messages.push(message)
  return message
}

function assistantMessageForGroup(
  messages: ChatTranscriptMessage[],
  currentAssistant: ChatTranscriptMessage | null,
  assistantMessagesByItemID: Map<string, ChatTranscriptMessage>,
  group: EventGroup,
) {
  const itemID = chatGroupItemID(group)
  if (!itemID) {
    return ensureAssistantMessage(messages, currentAssistant, group)
  }

  const existing = assistantMessagesByItemID.get(itemID)
  if (existing) {
    return existing
  }

  if (currentAssistant && !currentAssistant.text.trim() && currentAssistant.tools.length > 0) {
    assistantMessagesByItemID.set(itemID, currentAssistant)
    return currentAssistant
  }

  const message = chatMessageFromGroup('assistant', group)
  message.text = ''
  messages.push(message)
  assistantMessagesByItemID.set(itemID, message)
  return message
}

function mergeAssistantMessage(message: ChatTranscriptMessage, group: EventGroup) {
  if (group.kind === 'plan') {
    message.label = 'Plan'
    message.variant = 'plan'
  }
  message.text = mergeChatText(message.text, group.text)
  message.status = group.status
  message.streaming =
    group.events.some((event) => event.type === 'agent.message.delta' || isPlanDeltaEvent(event)) &&
    group.status !== 'completed'
  updateMessageRange(message, group)
}

function chatToolFromGroup(group: EventGroup): ChatTranscriptTool {
  return {
    id: group.id,
    kind: group.kind as ChatTranscriptTool['kind'],
    label: cleanToolLabel(group.label),
    status: group.status,
    text: chatToolText(group),
    error: group.error,
    paths: group.paths,
    startSeq: group.startSeq,
    endSeq: group.endSeq,
  }
}

function chatToolText(group: EventGroup) {
  if (group.kind === 'file-change') {
    const diffText = fileChangeDiffText(group)
    if (diffText) {
      return diffText
    }
  }

  const lines: string[] = []
  for (const event of group.events) {
    for (const line of toolTextLines(event.payload)) {
      if (!line || lines[lines.length - 1] === line) {
        continue
      }
      lines.push(line)
    }
  }
  if (lines.length > 0) {
    return lines.join('\n')
  }
  return group.paths.join('\n')
}

function fileChangeLabel(group: EventGroup) {
  const fileName = group.paths[0] ? basename(group.paths[0]) : ''
  if (!fileName) {
    return 'File change'
  }
  if (group.paths.length > 1) {
    return `${fileName} +${group.paths.length - 1}`
  }
  return fileName
}

function fileChangeDiffText(group: EventGroup) {
  const chunks: string[] = []
  for (const event of group.events) {
    for (const chunk of fileChangeDiffChunks(event.payload)) {
      if (!chunk || chunks[chunks.length - 1] === chunk) {
        continue
      }
      chunks.push(chunk)
    }
  }
  return chunks.join('\n')
}

function fileChangeDiffChunks(payload: unknown) {
  if (!isRecord(payload)) {
    return []
  }

  const direct = firstPayloadString(payload, [
    'diff',
    'patch',
    'unified_diff',
    'unifiedDiff',
    'text',
    'output',
    'summary',
  ])
  if (direct) {
    return [direct]
  }

  const changes = Array.isArray(payload.changes) ? payload.changes : []
  return changes.flatMap((change) => fileChangeDiffChunk(change))
}

function fileChangeDiffChunk(change: unknown) {
  if (!isRecord(change)) {
    return []
  }

  const direct = firstPayloadString(change, ['diff', 'patch', 'unified_diff', 'unifiedDiff'])
  if (direct) {
    return [direct]
  }

  const path = payloadString(change, ['path'])
  const oldText = firstPayloadString(change, ['old_text', 'oldText', 'before', 'previous', 'original'])
  const newText = firstPayloadString(change, ['new_text', 'newText', 'after', 'current', 'replacement'])
  if (oldText || newText) {
    return [simpleDiff(path, oldText, newText)]
  }

  const fallback = firstPayloadString(change, ['text', 'output', 'summary'])
  return fallback ? [path ? `${path}\n${fallback}` : fallback] : []
}

function simpleDiff(path: string, oldText: string, newText: string) {
  const lines: string[] = []
  if (path) {
    lines.push(`--- ${path}`)
    lines.push(`+++ ${path}`)
  }
  if (oldText) {
    lines.push(
      ...oldText
        .split('\n')
        .filter(Boolean)
        .map((line) => `- ${line}`),
    )
  }
  if (newText) {
    lines.push(
      ...newText
        .split('\n')
        .filter(Boolean)
        .map((line) => `+ ${line}`),
    )
  }
  return lines.join('\n')
}

function basename(path: string) {
  const trimmed = path.trim().replace(/\/+$/, '')
  return trimmed.split('/').filter(Boolean).pop() ?? trimmed
}

function firstPayloadString(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) {
      return value
    }
  }
  return ''
}

function toolLabelFromEvents(events: AgentEvent[]) {
  for (const event of [...events].reverse()) {
    const label = toolLabelFromPayload(event.payload)
    if (label) {
      return `Tool: ${label}`
    }
  }
  return 'Tool call'
}

function toolLabelFromPayload(payload: unknown) {
  if (!isRecord(payload)) {
    return ''
  }

  const itemType = payloadString(payload, ['item_type'])
  if (itemType === 'webSearch') {
    const query = toolQueryFromPayload(payload)
    return query ? `Web search: ${query}` : 'Web search'
  }

  const command = payloadString(payload, ['command'])
  if (command) {
    return cleanShellCommand(command)
  }

  const query = toolQueryFromPayload(payload)
  if (query) {
    return query
  }

  const name = payloadString(payload, ['name', 'tool', 'server', 'namespace', 'item_type'])
  return name
}

function toolTextLines(payload: unknown) {
  const text = cleanShellCommand(payloadText(payload))
  if (text) {
    return [text]
  }
  if (!isRecord(payload)) {
    return []
  }

  const itemType = payloadString(payload, ['item_type'])
  const queries = toolQueriesFromPayload(payload)
  const query = toolQueryFromPayload(payload)
  if (itemType === 'webSearch' || query || queries.length > 0) {
    const lines: string[] = []
    if (query) {
      lines.push(`Query: ${query}`)
    }
    if (queries.length > 0) {
      lines.push('Queries:')
      lines.push(...queries.map((value) => `- ${value}`))
    }
    return lines
  }

  return []
}

function toolQueryFromPayload(payload: unknown) {
  if (!isRecord(payload)) {
    return ''
  }
  const direct = payloadString(payload, ['query'])
  if (direct) {
    return direct
  }
  if (isRecord(payload.action)) {
    return payloadString(payload.action, ['query'])
  }
  return ''
}

function toolQueriesFromPayload(payload: unknown) {
  if (!isRecord(payload)) {
    return []
  }
  const values = isRecord(payload.action) ? payload.action.queries : payload.queries
  if (!Array.isArray(values)) {
    return []
  }
  return uniqueStrings(values.flatMap((value) => (typeof value === 'string' && value.trim() ? [value.trim()] : [])))
}

function cleanToolLabel(label: string) {
  const prefix = 'Tool: '
  if (!label.startsWith(prefix)) {
    return label
  }
  return `${prefix}${cleanShellCommand(label.slice(prefix.length))}`
}

function syncMessageTimelineItem(items: ChatTimelineItem[], message: ChatTranscriptMessage) {
  const existing = items.find((item) => item.kind === 'message' && item.message === message)
  if (existing) {
    existing.startSeq = message.startSeq
    existing.endSeq = message.endSeq
    return
  }
  items.push({
    kind: 'message',
    id: message.id,
    startSeq: message.startSeq,
    endSeq: message.endSeq,
    message,
  })
}

function isHiddenDebugGroup(group: EventGroup) {
  switch (group.kind) {
    case 'user-message':
    case 'action-break':
    case 'agent-message':
    case 'plan':
    case 'tool-call':
    case 'file-change':
    case 'error':
      return false
    default:
      return true
  }
}

function chatDebugEventFromGroup(group: EventGroup): ChatDebugEvent {
  return {
    id: `debug-${group.id}`,
    label: group.label,
    status: group.status,
    startSeq: group.startSeq,
    endSeq: group.endSeq,
    eventCount: group.events.length,
    text: group.text,
    error: group.error,
    payload: group.events.length === 1 ? group.events[0]?.payload : group.events.map(rawEventSummary),
    createdAt: group.events[0]?.created_at ?? '',
  }
}

function rawEventSummary(event: AgentEvent) {
  return {
    seq: event.seq,
    type: event.type,
    status: event.status,
    payload: event.payload,
    created_at: event.created_at,
  }
}

function cleanShellCommand(value: string) {
  const match = value.trim().match(/^(?:\/[^\s]+\/)?(?:zsh|bash|sh)\s+-lc\s+(.+)$/)
  if (!match) {
    return value
  }
  return unquoteShellArg(match[1])
}

function unquoteShellArg(value: string) {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function chatGroupItemID(group: EventGroup) {
  if (group.kind === 'plan') {
    return planItemID(group.events[0])
  }
  return payloadString(group.events[0]?.payload, ['item_id', 'message_id', 'id'])
}

function updateMessageRange(message: ChatTranscriptMessage, group: EventGroup) {
  message.startSeq = Math.min(message.startSeq, group.startSeq)
  message.endSeq = Math.max(message.endSeq, group.endSeq)
}

function mergeChatText(current: string, next: string) {
  if (!next) return current
  if (!current) return next
  if (next === current || current.endsWith(next)) return current
  if (next.startsWith(current)) return next
  return `${current}\n\n${next}`
}

function payloadPaths(payload: unknown) {
  if (!isRecord(payload)) {
    return []
  }

  const paths = new Set<string>()
  addPathValue(paths, payload.path)
  addPathValue(paths, payload.file)
  addPathValue(paths, payload.files)
  addPathValue(paths, payload.paths)
  addPathValue(paths, payload.changes)
  return [...paths]
}

function addPathValue(paths: Set<string>, value: unknown) {
  if (typeof value === 'string' && value.trim()) {
    paths.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        addPathValue(paths, item)
      } else if (isRecord(item)) {
        addPathValue(paths, item.path ?? item.file)
      }
    }
  }
}

function userInputRequestFromEvent(event: AgentEvent): PendingUserInputRequest | null {
  if (!isRecord(event.payload)) {
    return null
  }

  const requestID = payloadString(event.payload, ['request_id'])
  if (!requestID) {
    return null
  }
  const questions = payloadQuestions(event.payload.questions)
  if (questions.length === 0) {
    return null
  }

  return {
    requestID,
    provider: payloadString(event.payload, ['provider']),
    providerEventType: payloadString(event.payload, ['provider_event_type']),
    threadID: payloadString(event.payload, ['thread_id']),
    turnID: payloadString(event.payload, ['turn_id']),
    itemID: payloadString(event.payload, ['item_id']),
    questions,
    createdAt: event.created_at,
    seq: event.seq,
  }
}

function tokenUsageFromEvent(event: AgentEvent): TokenUsageSummary | null {
  if (
    event.type !== 'provider.codex.event' ||
    payloadString(event.payload, ['provider_event_type']) !== 'thread/tokenUsage/updated'
  ) {
    return null
  }
  if (!isRecord(event.payload) || !isRecord(event.payload.raw)) {
    return null
  }

  const tokenUsage = event.payload.raw.tokenUsage
  if (!isRecord(tokenUsage)) {
    return null
  }

  const total = tokenUsageSnapshot(tokenUsage.total)
  const last = tokenUsageSnapshot(tokenUsage.last)
  const modelContextWindow = payloadNumber(tokenUsage, ['modelContextWindow'])
  if (!total || !last || modelContextWindow <= 0) {
    return null
  }

  return {
    total,
    last,
    modelContextWindow,
    updatedAt: event.created_at,
    seq: event.seq,
  }
}

function tokenUsageSnapshot(value: unknown): TokenUsageSnapshot | null {
  if (!isRecord(value)) {
    return null
  }
  return {
    totalTokens: payloadNumber(value, ['totalTokens']),
    inputTokens: payloadNumber(value, ['inputTokens']),
    cachedInputTokens: payloadNumber(value, ['cachedInputTokens']),
    outputTokens: payloadNumber(value, ['outputTokens']),
    reasoningOutputTokens: payloadNumber(value, ['reasoningOutputTokens']),
  }
}

function payloadQuestions(value: unknown): UserInputQuestion[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return []
    }
    const id = payloadString(item, ['id'])
    const question = payloadString(item, ['question'])
    if (!id || !question) {
      return []
    }
    return [
      {
        id,
        header: payloadString(item, ['header']),
        question,
        is_other: item.is_other === true,
        is_secret: item.is_secret === true,
        options: payloadOptions(item.options),
      },
    ]
  })
}

function payloadOptions(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return []
    }
    const label = payloadString(item, ['label'])
    if (!label) {
      return []
    }
    return [
      {
        label,
        description: payloadString(item, ['description']),
      },
    ]
  })
}

function payloadNumber(payload: unknown, keys: string[]) {
  if (!isRecord(payload)) {
    return 0
  }
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }
  return 0
}

function payloadString(payload: unknown, keys: string[]) {
  if (!isRecord(payload)) {
    return ''
  }
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
    if (typeof value === 'number') {
      return String(value)
    }
  }
  return ''
}

function payloadLiteralString(payload: unknown, keys: string[]) {
  if (!isRecord(payload)) {
    return ''
  }
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value) {
      return value
    }
  }
  return ''
}

function joinGroupText(current: string, next: string) {
  if (!current) return next
  if (!next) return current
  return `${current}${next}`
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)]
}

function defaultOpen(kind: EventGroupKind, event: AgentEvent) {
  if (isErrorEvent(event.type, event.status)) return true
  if (kind === 'unknown') return false
  if ((kind === 'tool-call' || kind === 'file-change' || kind === 'log') && event.status === 'completed') {
    return false
  }
  return true
}
