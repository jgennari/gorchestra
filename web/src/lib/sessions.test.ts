import { nextSessionIDAfterArchive } from '@/lib/sessions'

const sessions = [{ id: 'sess_1' }, { id: 'sess_2' }, { id: 'sess_3' }]

test('nextSessionIDAfterArchive selects the next session when archiving the current one', () => {
  expect(nextSessionIDAfterArchive(sessions, 'sess_2', 'sess_2')).toBe('sess_3')
})

test('nextSessionIDAfterArchive selects the previous session when archiving the last one', () => {
  expect(nextSessionIDAfterArchive(sessions, 'sess_3', 'sess_3')).toBe('sess_2')
})

test('nextSessionIDAfterArchive keeps the current selection when archiving a different session', () => {
  expect(nextSessionIDAfterArchive(sessions, 'sess_2', 'sess_1')).toBe('sess_1')
})

test('nextSessionIDAfterArchive clears selection when no sessions remain', () => {
  expect(nextSessionIDAfterArchive([{ id: 'sess_1' }], 'sess_1', 'sess_1')).toBeNull()
})
