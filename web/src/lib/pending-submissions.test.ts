import { createFakeIndexedDB } from '@/test/fake-indexeddb'
import { readPendingSubmissions, removePendingSubmission, savePendingSubmission, type PendingSubmission } from '@/lib/pending-submissions'

const pending: PendingSubmission = {
  id: 'stable-id', sessionID: 'session', content: 'preserve me', queue: true,
  options: { codex: { model: 'test' } }, skills: [{ name: 'test', path: '/skills/test' }],
  attachments: [{ name: 'test.png', media_type: 'image/png', data_url: 'data:image/png;base64,dGVzdA==', size_bytes: 4 }],
  createdAt: '2026-09-06T00:00:00Z',
}
beforeEach(() => window.localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

test.each([true, false])('pending request survives storage round-trip with exact identity/options/attachments (IndexedDB=%s)', async (idb) => {
  vi.stubGlobal('indexedDB', idb ? createFakeIndexedDB() : undefined)
  await savePendingSubmission(pending)
  expect(await readPendingSubmissions('session')).toEqual([pending])
  expect(await readPendingSubmissions('other')).toEqual([])
  await removePendingSubmission(pending.id)
  expect(await readPendingSubmissions('session')).toEqual([])
})
