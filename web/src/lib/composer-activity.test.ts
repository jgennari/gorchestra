import { publishComposerActivity, subscribeComposerActivity } from '@/lib/composer-activity'

test('publishes bounded edit intensity without exposing draft text', () => {
  const subscriber = vi.fn()
  const unsubscribe = subscribeComposerActivity(subscriber)

  publishComposerActivity('sess_1', 1)
  publishComposerActivity('sess_1', 100)
  publishComposerActivity(undefined, 4)

  expect(subscriber).toHaveBeenNthCalledWith(1, { sessionID: 'sess_1', intensity: 0.5 })
  expect(subscriber).toHaveBeenNthCalledWith(2, { sessionID: 'sess_1', intensity: 1 })
  expect(subscriber).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(subscriber.mock.calls)).not.toContain('draft')

  unsubscribe()
  publishComposerActivity('sess_1', 1)
  expect(subscriber).toHaveBeenCalledTimes(2)
})
