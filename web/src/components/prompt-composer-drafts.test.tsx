import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PromptComposer } from '@/components/prompt-composer'
import { clearAPIRequestCachesForTest } from '@/lib/api'
import { composerStorageKey, loadComposerDraft, tabDraftStorageKey, type ComposerDraft } from '@/lib/composer-drafts'

const sessionID = 'draft-session'
const sharedKey = composerStorageKey(sessionID)
const legacyKey = `gorchestra.draft-version.v1.${sessionID}.previous-editor`
const draft = (text: string): ComposerDraft => ({ draft: text, selectedSkills: [] })

beforeEach(() => {
  window.localStorage.clear()
  clearAPIRequestCachesForTest()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"messages":[]}')))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear() })

function openComposer(onSubmit: () => Promise<void> = vi.fn(async () => undefined)) {
  return render(<PromptComposer sessionID={sessionID} disabled={false} disabledReason="" onSubmit={onSubmit} />)
}

function externalDraft(next: ComposerDraft) {
  const oldValue = window.localStorage.getItem(sharedKey)
  const newValue = JSON.stringify(next)
  window.localStorage.setItem(sharedKey, newValue)
  fireEvent(window, new StorageEvent('storage', { key: sharedKey, oldValue, newValue }))
}

test('same-tab remount restores directly in the composer without a duplicate recovery list', () => {
  window.localStorage.setItem(legacyKey, JSON.stringify({ draft: 'Old text from this tab', updatedAt: 1 }))
  const first = openComposer()
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Current local text' } })
  first.unmount()
  openComposer()
  expect(screen.getByLabelText('Prompt')).toHaveValue('Current local text')
  expect(screen.queryByText(/Saved drafts from other tabs/)).not.toBeInTheDocument()
  expect(screen.queryByText('Use saved draft')).not.toBeInTheDocument()
  expect(window.localStorage.getItem(legacyKey)).not.toBeNull() // No destructive migration of older copies.
})

test('a new tab restores the shared draft and its skills into the composer', () => {
  const saved = { draft: 'Review this $review', selectedSkills: [{ name: 'review', path: '/review/SKILL.md' }] }
  window.localStorage.setItem(sharedKey, JSON.stringify(saved))
  openComposer()
  expect(screen.getByLabelText('Prompt')).toHaveValue(saved.draft)
  expect(loadComposerDraft(sessionID)).toEqual(saved)
})

test('a malformed tab snapshot falls back to the current saved draft, not obsolete versions', () => {
  window.sessionStorage.setItem(tabDraftStorageKey(sessionID), '{broken')
  window.localStorage.setItem(sharedKey, JSON.stringify(draft('Recover this draft')))
  window.localStorage.setItem(legacyKey, JSON.stringify({ draft: 'Obsolete draft', updatedAt: Date.now() }))
  openComposer()
  expect(screen.getByLabelText('Prompt')).toHaveValue('Recover this draft')
})

test('local text and skills win against another tab, including after remount', () => {
  const local = { draft: 'Local $local', selectedSkills: [{ name: 'local', path: '/local/SKILL.md' }] }
  window.sessionStorage.setItem(tabDraftStorageKey(sessionID), JSON.stringify(local))
  const app = openComposer()
  externalDraft({ draft: 'Other $other', selectedSkills: [{ name: 'other', path: '/other/SKILL.md' }] })
  expect(screen.getByLabelText('Prompt')).toHaveValue(local.draft)
  expect(loadComposerDraft(sessionID)).toEqual(local)
  app.unmount()
  openComposer()
  expect(screen.getByLabelText('Prompt')).toHaveValue(local.draft)
  // Opening the tab is not an edit and cannot overwrite the shared latest draft.
  expect(JSON.parse(window.localStorage.getItem(sharedKey)!).draft).toBe('Other $other')
})

test('an empty composer adopts an incoming saved draft without echoing a write to other tabs', () => {
  const submit = vi.fn(async () => undefined)
  openComposer(submit)
  const saved = draft('Incoming saved draft')
  const newValue = JSON.stringify(saved)
  window.localStorage.setItem(sharedKey, newValue)
  const write = vi.spyOn(window.localStorage, 'setItem')
  fireEvent(window, new StorageEvent('storage', { key: sharedKey, oldValue: JSON.stringify(draft('')), newValue }))
  expect(screen.getByLabelText('Prompt')).toHaveValue(saved.draft)
  expect(loadComposerDraft(sessionID)).toEqual(saved)
  expect(write).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
})

test('an adopted draft follows subsequent saved edits until this tab edits locally', () => {
  openComposer()
  externalDraft(draft('H'))
  externalDraft(draft('Hello'))
  expect(screen.getByLabelText('Prompt')).toHaveValue('Hello')
  externalDraft(draft('')) // The other tab sent it; an unedited mirror should clear too.
  expect(screen.getByLabelText('Prompt')).toHaveValue('')
  externalDraft(draft('Next draft'))
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'My local edit' } })
  externalDraft(draft('Competing remote edit'))
  expect(screen.getByLabelText('Prompt')).toHaveValue('My local edit')
})

test.each(['text', 'whitespace', 'image'])('an incoming saved draft does not replace local %s', async (kind) => {
  openComposer()
  if (kind === 'image') {
    await userEvent.setup().upload(screen.getByLabelText('Image attachments'), new File(['image'], 'local.png', { type: 'image/png' }))
    await screen.findByAltText('local.png')
  } else {
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: kind === 'text' ? 'Local wins' : ' ' } })
  }
  const value = (screen.getByLabelText('Prompt') as HTMLTextAreaElement).value
  externalDraft(draft('Competing draft'))
  expect(screen.getByLabelText('Prompt')).toHaveValue(value)
  if (kind === 'image') expect(screen.getByAltText('local.png')).toBeInTheDocument()
})

test('sent text and old recovery copies stay cleared when this tab reloads', async () => {
  const submit = vi.fn(async () => undefined)
  const app = openComposer(submit)
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Already sent' } })
  fireEvent.keyDown(screen.getByLabelText('Prompt'), { key: 'Enter' })
  await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(''))
  expect(submit).toHaveBeenCalledWith('Already sent')
  app.unmount()
  window.localStorage.setItem(sharedKey, JSON.stringify(draft('Stale text from another tab')))
  window.localStorage.setItem(legacyKey, JSON.stringify({ draft: 'Already sent', updatedAt: Date.now() }))
  openComposer()
  expect(screen.getByLabelText('Prompt')).toHaveValue('')
})

test('provider-only storage updates do not resurrect old shared text in an empty composer', () => {
  window.sessionStorage.setItem(tabDraftStorageKey(sessionID), JSON.stringify(draft('')))
  const oldValue = JSON.stringify({ ...draft('Stale shared text'), codexSelection: { model: 'before' } })
  window.localStorage.setItem(sharedKey, oldValue)
  openComposer()
  fireEvent(window, new StorageEvent('storage', {
    key: sharedKey, oldValue, newValue: JSON.stringify({ ...draft('Stale shared text'), codexSelection: { model: 'after' } }),
  }))
  expect(screen.getByLabelText('Prompt')).toHaveValue('')
})

test('receiving a draft while a send is pending cannot refill the cleared composer', async () => {
  let finish!: () => void
  openComposer(vi.fn(() => new Promise<void>((resolve) => { finish = resolve })))
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Sending now' } })
  fireEvent.keyDown(screen.getByLabelText('Prompt'), { key: 'Enter' })
  externalDraft(draft('Another tab'))
  await act(async () => finish())
  expect(screen.getByLabelText('Prompt')).toHaveValue('')
})

test('draft persistence leaves provider settings intact and reports unavailable storage', async () => {
  const codexSelection = { model: 'custom-model', reasoning_effort: 'high' }
  window.localStorage.setItem(sharedKey, JSON.stringify({ codexSelection }))
  openComposer()
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Saved normally' } })
  expect(JSON.parse(window.localStorage.getItem(sharedKey)!)).toMatchObject({ codexSelection, draft: 'Saved normally' })
  vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('Quota') })
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Keep this visible' } })
  expect(await screen.findByRole('alert')).toHaveTextContent('Draft storage is unavailable')
  expect(screen.getByLabelText('Prompt')).toHaveValue('Keep this visible')
})
