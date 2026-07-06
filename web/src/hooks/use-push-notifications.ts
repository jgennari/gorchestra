import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { AgentEvent, PushSubscriptionPayload } from '@/lib/api'
import {
  deletePushSubscription,
  fetchNotificationPublicKey,
  savePushSubscription,
  sendTestNotification,
} from '@/lib/api'

type NotificationStatus = 'unsupported' | 'default' | 'denied' | 'enabling' | 'enabled' | 'error'
type NotificationTestState = 'idle' | 'sending' | 'sent'
type SessionStopNotificationDetails = {
  title?: string
  excerpt?: string
}

type WindowWithWebkitAudio = Window & {
  webkitAudioContext?: typeof AudioContext
}

const enabledStorageKey = 'gorchestra.notifications.enabled'
const soundStorageKey = 'gorchestra.notifications.sound'

export function usePushNotifications() {
  const supported = useMemo(() => supportsPushNotifications(), [])
  const [status, setStatus] = useState<NotificationStatus>(() => initialStatus(supported))
  const [error, setError] = useState('')
  const [testState, setTestState] = useState<NotificationTestState>('idle')
  const [soundEnabled, setSoundEnabledState] = useState(() => readBooleanStorage(soundStorageKey, false))
  const playedEventsRef = useRef<Set<string>>(new Set())
  const shownTerminalNotificationsRef = useRef<Set<string>>(new Set())
  const audioContextRef = useRef<AudioContext | null>(null)

  useEffect(() => {
    if (!supported) {
      setStatus('unsupported')
      return
    }
    if (Notification.permission === 'denied') {
      setStatus('denied')
      return
    }
    if (Notification.permission === 'granted' && readBooleanStorage(enabledStorageKey, false)) {
      setStatus('enabled')
      return
    }
    setStatus('default')
  }, [supported])

  useEffect(() => {
    if (!supported || Notification.permission !== 'granted') {
      return
    }

    let cancelled = false
    async function restoreExistingSubscription() {
      try {
        const registration = await navigator.serviceWorker.getRegistration('/')
        const subscription = registration ? await registration.pushManager.getSubscription() : null
        if (cancelled || !subscription) {
          return
        }
        await savePushSubscription(subscription.toJSON() as PushSubscriptionPayload)
        if (cancelled) {
          return
        }
        writeBooleanStorage(enabledStorageKey, true)
        setStatus('enabled')
      } catch {
        // Keep the current UI state; explicit enable/test actions will surface API errors.
      }
    }

    void restoreExistingSubscription()
    return () => {
      cancelled = true
    }
  }, [supported])

  const enable = useCallback(async () => {
    if (!supported) {
      setStatus('unsupported')
      return
    }

    setStatus('enabling')
    setError('')
    try {
      let permission = Notification.permission
      if (permission === 'default') {
        permission = await Notification.requestPermission()
      }
      if (permission === 'denied') {
        writeBooleanStorage(enabledStorageKey, false)
        setStatus('denied')
        return
      }
      if (permission !== 'granted') {
        writeBooleanStorage(enabledStorageKey, false)
        setStatus('default')
        return
      }

      const registration = await navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
      const { public_key: publicKey } = await fetchNotificationPublicKey()
      const currentSubscription = await registration.pushManager.getSubscription()
      const subscription =
        currentSubscription ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }))
      await savePushSubscription(subscription.toJSON() as PushSubscriptionPayload)
      writeBooleanStorage(enabledStorageKey, true)
      setStatus('enabled')
    } catch (enableError) {
      writeBooleanStorage(enabledStorageKey, false)
      setError(messageFromUnknown(enableError))
      setStatus('error')
    }
  }, [supported])

  const disable = useCallback(async () => {
    setError('')
    try {
      const registration = supported ? await navigator.serviceWorker.getRegistration('/') : null
      const subscription = registration ? await registration.pushManager.getSubscription() : null
      if (subscription?.endpoint) {
        await deletePushSubscription(subscription.endpoint)
        await subscription.unsubscribe()
      }
      writeBooleanStorage(enabledStorageKey, false)
      setStatus(supported && Notification.permission === 'denied' ? 'denied' : supported ? 'default' : 'unsupported')
    } catch (disableError) {
      setError(messageFromUnknown(disableError))
      setStatus('error')
    }
  }, [supported])

  const sendTest = useCallback(async () => {
    setError('')
    setTestState('sending')
    try {
      await sendTestNotification()
      await showLocalTestNotification(supported)
      setTestState('sent')
    } catch (testError) {
      setError(messageFromUnknown(testError))
      setStatus((current) => (current === 'enabled' ? current : 'error'))
      setTestState('idle')
    }
  }, [supported])

  const setSoundEnabled = useCallback((enabled: boolean) => {
    writeBooleanStorage(soundStorageKey, enabled)
    setSoundEnabledState(enabled)
    if (enabled) {
      void ensureAudioContext(audioContextRef)
    }
  }, [])

  const playSessionStopSound = useCallback(
    (event: AgentEvent) => {
      if (!soundEnabled || !isPushNotificationTerminalEvent(event.type)) {
        return
      }
      const eventKey = event.id || `${event.session_id}:${event.seq}`
      if (playedEventsRef.current.has(eventKey)) {
        return
      }
      playedEventsRef.current.add(eventKey)
      if (playedEventsRef.current.size > 200) {
        const firstKey = playedEventsRef.current.values().next().value
        if (firstKey) {
          playedEventsRef.current.delete(firstKey)
        }
      }
      void playNotificationTone(audioContextRef)
    },
    [soundEnabled],
  )

  const showSessionStopNotification = useCallback(
    (event: AgentEvent, details: SessionStopNotificationDetails = {}) => {
      if (
        !supported ||
        !isPushNotificationTerminalEvent(event.type) ||
        Notification.permission !== 'granted' ||
        document.visibilityState !== 'visible'
      ) {
        return
      }

      const eventKey = event.id || `${event.session_id}:${event.seq}`
      if (shownTerminalNotificationsRef.current.has(eventKey)) {
        return
      }
      shownTerminalNotificationsRef.current.add(eventKey)
      if (shownTerminalNotificationsRef.current.size > 200) {
        const firstKey = shownTerminalNotificationsRef.current.values().next().value
        if (firstKey) {
          shownTerminalNotificationsRef.current.delete(firstKey)
        }
      }

      void showLocalSessionStopNotification(event, details)
    },
    [supported],
  )

  return {
    supported,
    status,
    error,
    testState,
    soundEnabled,
    enable,
    disable,
    sendTest,
    setSoundEnabled,
    playSessionStopSound,
    showSessionStopNotification,
  }
}

function supportsPushNotifications() {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  )
}

function initialStatus(supported: boolean): NotificationStatus {
  if (!supported) {
    return 'unsupported'
  }
  if (Notification.permission === 'denied') {
    return 'denied'
  }
  if (Notification.permission === 'granted' && readBooleanStorage(enabledStorageKey, false)) {
    return 'enabled'
  }
  return 'default'
}

function urlBase64ToUint8Array(value: string) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const output = new Uint8Array(rawData.length)
  for (let index = 0; index < rawData.length; index += 1) {
    output[index] = rawData.charCodeAt(index)
  }
  return output
}

async function ensureAudioContext(audioContextRef: MutableRefObject<AudioContext | null>) {
  if (!audioContextRef.current) {
    const AudioContextConstructor = window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext
    if (!AudioContextConstructor) {
      return null
    }
    audioContextRef.current = new AudioContextConstructor()
  }
  if (audioContextRef.current.state === 'suspended') {
    await audioContextRef.current.resume()
  }
  return audioContextRef.current
}

async function playNotificationTone(audioContextRef: MutableRefObject<AudioContext | null>) {
  const context = await ensureAudioContext(audioContextRef)
  if (!context) {
    return
  }

  const start = context.currentTime
  const gain = context.createGain()
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(0.08, start + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.48)
  gain.connect(context.destination)

  for (const [offset, frequency] of [
    [0, 660],
    [0.16, 880],
  ] as const) {
    const oscillator = context.createOscillator()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(frequency, start + offset)
    oscillator.connect(gain)
    oscillator.start(start + offset)
    oscillator.stop(start + offset + 0.18)
  }
}

async function showLocalTestNotification(supported: boolean) {
  if (!supported || Notification.permission !== 'granted') {
    return
  }
  const registration = await navigator.serviceWorker.ready
  await registration.showNotification('Gorchestra notifications enabled', {
    body: 'Test notification from this device.',
    badge: '/favicon-notify.svg',
    icon: '/icon.svg',
    tag: 'gorchestra-local-test',
    data: { url: '/' },
  })
}

async function showLocalSessionStopNotification(event: AgentEvent, details: SessionStopNotificationDetails) {
  try {
    const registration = await navigator.serviceWorker.ready
    await registration.showNotification(sessionStopNotificationTitle(event.type), {
      body: sessionStopNotificationBody(details),
      badge: '/favicon-notify.svg',
      icon: '/icon.svg',
      tag: `gorchestra-session-${event.session_id}`,
      data: { url: `/sessions/${event.session_id}`, session_id: event.session_id, event_type: event.type },
    })

    const badgeNavigator = navigator as Navigator & { setAppBadge?: (contents?: number) => Promise<void> }
    if (badgeNavigator.setAppBadge) {
      await badgeNavigator.setAppBadge(1).catch(() => undefined)
    }
  } catch {
    // Local foreground notifications are best-effort; background push remains the primary path.
  }
}

function isPushNotificationTerminalEvent(type: string) {
  return type === 'agent.run.completed' || type === 'agent.run.failed' || type === 'agent.run.cancelled'
}

function sessionNotificationName(details: SessionStopNotificationDetails) {
  const title = singleLineText(details.title ?? '')
  return title || 'Untitled session'
}

function sessionStopNotificationTitle(type: string) {
  if (type === 'agent.run.completed') {
    return 'Completed'
  }
  if (type === 'agent.run.cancelled') {
    return 'Cancelled'
  }
  return 'Failed'
}

function sessionStopNotificationBody(details: SessionStopNotificationDetails) {
  const sessionName = sessionNotificationName(details)
  const cleanedExcerpt = singleLineText(details.excerpt ?? '')
  if (!cleanedExcerpt) {
    return sessionName
  }
  return `${sessionName}: ${cleanedExcerpt}`
}

function singleLineText(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).join(' ')
}

function readBooleanStorage(key: string, fallback: boolean) {
  try {
    const value = window.localStorage.getItem(key)
    if (value === 'true') return true
    if (value === 'false') return false
  } catch {
    return fallback
  }
  return fallback
}

function writeBooleanStorage(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? 'true' : 'false')
  } catch {
    // Storage failures should not prevent permission changes.
  }
}

function messageFromUnknown(error: unknown) {
  return error instanceof Error ? error.message : 'Notification request failed'
}
