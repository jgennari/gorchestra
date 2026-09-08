import type { ComponentProps } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PromptComposer } from '@/components/prompt-composer'
import { clearAPIRequestCachesForTest, type AgentEvent, type QueuedMessage } from '@/lib/api'
import { loadComposerDraft } from '@/lib/composer-drafts'

const storageKey = 'gorchestra.session-composer.sess_1'
const queueURL = '/api/sessions/sess_1/queued-messages'
const message = (id: string, content: string, seq: number): QueuedMessage => ({ id, content, seq, session_id: 'sess_1', created_at: '2026-09-08T12:00:00Z' })
const first = message('q1', 'First queued prompt', 1)
const second = message('q2', 'Second queued prompt', 2)
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
const stop = () => fireEvent.click(screen.getByRole('button', { name: 'Cancel running session' }))
const move = (index = 1) => fireEvent.click(screen.getByRole('button', { name: `Move queued message ${index} to composer` }))
const draft = () => JSON.parse(window.localStorage.getItem(storageKey) ?? '{}')

function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function setup(messages: QueuedMessage[] = [first, second], overrides: Partial<ComponentProps<typeof PromptComposer>> = {}) {
  const queued = [...messages]
  const removedDrafts: unknown[] = []
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === queueURL) return response({ messages: queued })
    if (String(url).startsWith(queueURL + '/') && init?.method === 'DELETE') {
      removedDrafts.push(draft())
      const index = queued.findIndex((item) => String(url) === `${queueURL}/${item.id}`)
      if (index < 0) return new Response('{"error":"not queued"}', { status: 404 })
      return response(queued.splice(index, 1)[0])
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  const props: ComponentProps<typeof PromptComposer> = {
    sessionID: 'sess_1', disabled: true, disabledReason: 'Running', sessionStatus: 'running',
    onSubmit: vi.fn(async () => undefined), onCancel: vi.fn(async () => undefined), onError: vi.fn(),
    ...overrides,
  }
  const app = render(<PromptComposer {...props} />)
  if (messages.length) await screen.findByRole('button', { name: 'Move queued message 1 to composer' })
  else await waitFor(() => expect(fetch).toHaveBeenCalled())
  return { app, props, fetch, queued, removedDrafts, deletes: () => fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE') }
}

beforeEach(() => { clearAPIRequestCachesForTest(); window.localStorage.clear() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear() })

test('manual move replaces text, skills and images with the chosen message without stopping or sending', async () => {
  window.localStorage.setItem(storageKey, JSON.stringify({ draft: 'Existing draft', selectedSkills: [{ name: 'old', path: '/old/SKILL.md' }] }))
  const skill = { name: 'review', path: '/review/SKILL.md' }
  const state = await setup([first, { ...second, skills: [skill] }])
  await userEvent.setup().upload(screen.getByLabelText('Image attachments'), new File(['image'], 'draft.png', { type: 'image/png' }))
  await screen.findByAltText('draft.png')
  move(2)
  await waitFor(() => expect(state.queued).toEqual([first]))
  expect(screen.getByLabelText('Prompt')).toHaveValue('Second queued prompt $review ')
  expect(screen.getByLabelText('Prompt')).toHaveFocus()
  expect(screen.queryByAltText('draft.png')).not.toBeInTheDocument()
  expect(draft()).toMatchObject({ draft: 'Second queued prompt $review ', selectedSkills: [skill] })
  expect(state.removedDrafts).toEqual([expect.objectContaining({ draft: 'Second queued prompt $review ', selectedSkills: [skill] })])
  expect(state.props.onSubmit).not.toHaveBeenCalled()
  expect(state.props.onCancel).not.toHaveBeenCalled()
  expect(state.deletes()[0][0]).toBe(`${queueURL}/q2`)
})

test('Stop waits for cancellation, then restores the oldest server-queued message and leaves the rest', async () => {
  const cancellation = pending<void>()
  const state = await setup([second, first], { onCancel: vi.fn(() => cancellation.promise) })
  stop()
  stop()
  expect(state.props.onCancel).toHaveBeenCalledOnce()
  expect(state.deletes()).toHaveLength(0)
  expect(screen.getByLabelText('Prompt')).toHaveValue('')
  await act(async () => cancellation.resolve())
  await waitFor(() => expect(state.queued).toEqual([second]))
  expect(screen.getByLabelText('Prompt')).toHaveValue(first.content)
  expect(state.deletes()).toHaveLength(1)
  expect(state.props.onSubmit).not.toHaveBeenCalled()
})

test.each(['text', 'whitespace', 'skills', 'image'])('Stop preserves an existing %s draft and leaves the queue alone', async (kind) => {
  if (kind === 'skills') window.localStorage.setItem(storageKey, JSON.stringify({ selectedSkills: [{ name: 'keep', path: '/keep/SKILL.md' }] }))
  const state = await setup()
  const prompt = screen.getByLabelText('Prompt')
  if (kind === 'text' || kind === 'whitespace') fireEvent.change(prompt, { target: { value: kind === 'text' ? 'Keep this draft' : ' ' } })
  if (kind === 'image') {
    await userEvent.setup().upload(screen.getByLabelText('Image attachments'), new File(['image'], 'keep.png', { type: 'image/png' }))
    await screen.findByAltText('keep.png')
  }
  const value = (prompt as HTMLTextAreaElement).value
  stop()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel running session' })).toBeEnabled())
  expect(state.props.onCancel).toHaveBeenCalledOnce()
  expect(state.deletes()).toHaveLength(0)
  expect(state.queued).toEqual([first, second])
  expect(prompt).toHaveValue(value)
  if (kind === 'image') expect(screen.getByAltText('keep.png')).toBeInTheDocument()
})

test.each(['cancel', 'queue read'])('typing during the pending %s prevents automatic restoration', async (phase) => {
  const cancellation = pending<void>()
  const state = await setup([first], { onCancel: vi.fn(() => cancellation.promise) })
  const read = pending<Response>()
  if (phase === 'queue read') state.fetch.mockImplementationOnce(() => read.promise)
  stop()
  if (phase === 'queue read') await act(async () => cancellation.resolve())
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'New draft while waiting' } })
  await act(async () => {
    if (phase === 'queue read') read.resolve(response({ messages: [first] }))
    else cancellation.resolve()
  })
  expect(screen.getByLabelText('Prompt')).toHaveValue('New draft while waiting')
  expect(state.deletes()).toHaveLength(0)
  expect(state.props.onSubmit).not.toHaveBeenCalled()
})

test('failed cancellation never dequeues a message', async () => {
  const state = await setup([first], { onCancel: vi.fn(async () => { throw new Error('Already stopped') }) })
  stop()
  await waitFor(() => expect(state.props.onError).toHaveBeenCalledWith('Already stopped'))
  expect(state.deletes()).toHaveLength(0)
  expect(screen.getByLabelText('Prompt')).toHaveValue('')
})

test.each(['Stop', 'manual move'])('%s handles an image still being read without accidentally overwriting the draft', async (action) => {
  const cancellation = pending<void>()
  const state = await setup([first], { onCancel: vi.fn(() => cancellation.promise) })
  const read = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(() => {})
  if (action === 'Stop') stop()
  fireEvent.change(screen.getByLabelText('Image attachments'), { target: { files: [new File(['image'], 'pending.png', { type: 'image/png' })] } })
  if (action === 'Stop') await act(async () => cancellation.resolve())
  else move()
  await act(async () => {
    const reader = read.mock.contexts[0] as FileReader
    Object.defineProperty(reader, 'result', { value: 'data:image/png;base64,aW1hZ2U=' })
    reader.dispatchEvent(new Event('load'))
  })
  if (action === 'Stop') {
    expect(state.deletes()).toHaveLength(0)
    expect(screen.getByLabelText('Prompt')).toHaveValue('')
    expect(screen.getByAltText('pending.png')).toBeInTheDocument()
  } else {
    expect(screen.queryByAltText('pending.png')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Prompt')).toHaveValue(first.content)
    expect(state.deletes()).toHaveLength(1)
  }
})

test('leaving the session while Stop is pending does not dequeue or alter its draft', async () => {
  const cancellation = pending<void>()
  const state = await setup([first], { onCancel: vi.fn(() => cancellation.promise) })
  stop()
  state.app.unmount()
  await act(async () => cancellation.resolve())
  expect(state.deletes()).toHaveLength(0)
  expect(loadComposerDraft('sess_1').draft).toBe('')
})

test('a fresh queue read does not resurrect old queued events from another device', async () => {
  const queuedEvent: AgentEvent = { id: 'event_1', session_id: 'sess_1', seq: 1, type: 'user.message.queued', role: 'user', status: 'completed', payload: { queue_item_id: 'q1', text: first.content }, created_at: first.created_at }
  const state = await setup([first], { queueEvents: [queuedEvent] })
  state.queued.splice(0) // Another device consumed it without this client seeing the removal yet.
  stop()
  await waitFor(() => expect(state.fetch.mock.calls.filter(([url]) => url === queueURL)).toHaveLength(2))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Move queued message 1 to composer' })).not.toBeInTheDocument())
  expect(state.deletes()).toHaveLength(0)
  expect(screen.getByLabelText('Prompt')).toHaveValue('')
})

test('edits made during removal survive, with sends blocked until the move finishes', async () => {
  const state = await setup([first], { disabled: false })
  const removal = pending<Response>()
  state.fetch.mockImplementationOnce(() => removal.promise)
  move()
  expect(screen.getByLabelText('Prompt')).toHaveValue(first.content)
  expect(screen.getByRole('button', { name: 'Submit prompt' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Move queued message 1 to composer' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Edited restored prompt' } })
  await act(async () => removal.resolve(response(first)))
  expect(screen.getByLabelText('Prompt')).toHaveValue('Edited restored prompt')
  expect(draft().draft).toBe('Edited restored prompt')
  expect(state.props.onSubmit).not.toHaveBeenCalled()
})

test('a lost deletion response leaves a durable copy and reports the uncertainty', async () => {
  const state = await setup([first])
  state.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
  move()
  await waitFor(() => expect(state.props.onError).toHaveBeenCalledWith(expect.stringContaining('queue removal could not be confirmed')))
  expect(screen.getByLabelText('Prompt')).toHaveValue(first.content)
  expect(draft().draft).toBe(first.content)
  expect(state.props.onSubmit).not.toHaveBeenCalled()
  expect(state.deletes()).toHaveLength(1)
})

test('closing the composer during deletion keeps the restored message saved', async () => {
  const state = await setup([first])
  const removal = pending<Response>()
  state.fetch.mockImplementationOnce(() => removal.promise)
  move()
  state.app.unmount()
  await act(async () => removal.resolve(response(first)))
  expect(draft().draft).toBe(first.content)
  expect(loadComposerDraft('sess_1').draft).toBe(first.content)
})

test('unavailable draft storage prevents removal and does not overwrite the composer', async () => {
  const state = await setup([first])
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Keep original' } })
  vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('Quota') })
  move()
  await waitFor(() => expect(state.props.onError).toHaveBeenCalledWith(expect.stringContaining('message was left queued')))
  expect(state.deletes()).toHaveLength(0)
  expect(screen.getByLabelText('Prompt')).toHaveValue('Keep original')
  expect(loadComposerDraft('sess_1').draft).toBe('Keep original')
})

test('queue move and delete actions are unavailable offline', async () => {
  const state = await setup([first])
  state.app.rerender(<PromptComposer {...state.props} offline />)
  expect(screen.getByRole('button', { name: 'Move queued message 1 to composer' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Remove queued message 1' })).toBeDisabled()
  expect(state.deletes()).toHaveLength(0)
})
