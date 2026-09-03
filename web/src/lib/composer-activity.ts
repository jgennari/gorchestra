export type ComposerActivity = {
  sessionID: string
  intensity: number
}

type ComposerActivitySubscriber = (activity: ComposerActivity) => void

const subscribers = new Set<ComposerActivitySubscriber>()

export function publishComposerActivity(sessionID: string | undefined, changedCharacters: number) {
  if (!sessionID) return
  const activity = {
    sessionID,
    intensity: Math.min(1, 0.42 + Math.max(1, changedCharacters) * 0.08),
  }
  for (const subscriber of subscribers) subscriber(activity)
}

export function subscribeComposerActivity(subscriber: ComposerActivitySubscriber) {
  subscribers.add(subscriber)
  return () => {
    subscribers.delete(subscriber)
  }
}
