import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { usePushNotifications } from '@/hooks/use-push-notifications'
import { acknowledgeNotification, savePushSubscription, type AgentEvent } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  acknowledgeNotification: vi.fn(),
  savePushSubscription: vi.fn(),
  deletePushSubscription: vi.fn(),
  fetchNotificationPublicKey: vi.fn(),
  sendTestNotification: vi.fn(),
}))

const subscription = {
  endpoint: 'https://push.example.test/this-device',
  toJSON: () => ({ endpoint: 'https://push.example.test/this-device', keys: { p256dh: 'key', auth: 'auth' } }),
}
const getSubscription = vi.fn()
const showNotification = vi.fn()
const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')

beforeEach(() => {
  vi.resetAllMocks()
  window.localStorage.clear()
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('Notification', { permission: 'granted' })
  vi.stubGlobal('PushManager', class {})
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  getSubscription.mockResolvedValue(subscription)
  showNotification.mockResolvedValue(undefined)
  vi.mocked(acknowledgeNotification).mockResolvedValue({ acknowledged: true })
  vi.mocked(savePushSubscription).mockResolvedValue({ enabled: true })
  const registration = { pushManager: { getSubscription }, showNotification }
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: vi.fn().mockResolvedValue(registration), ready: Promise.resolve(registration) },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalServiceWorker) Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker)
  else Reflect.deleteProperty(navigator, 'serviceWorker')
})

test.each(['agent.run.completed', 'agent.run.failed', 'agent.run.cancelled', 'agent.permission.requested'])(
  'acknowledges a viewed %s without showing a second local notification', async (type) => {
    const { result } = renderHook(() => usePushNotifications())
    await waitFor(() => expect(result.current.status).toBe('enabled'))
    await act(() => result.current.acknowledgeSessionNotification(event(type)))
    expect(acknowledgeNotification).toHaveBeenCalledExactlyOnceWith(subscription.endpoint, 'sess_1', 8)
    expect(showNotification).not.toHaveBeenCalled()
  },
)

test.each(['agent.message.completed', 'agent.message.delta', 'agent.run.started', 'tool.call.completed'])(
  'does not send ACK requests for non-notifying %s', async (type) => {
    const { result } = renderHook(() => usePushNotifications())
    await waitFor(() => expect(result.current.status).toBe('enabled'))
    const readsBefore = getSubscription.mock.calls.length
    await act(() => result.current.acknowledgeSessionNotification(event(type)))
    expect(getSubscription).toHaveBeenCalledTimes(readsBefore)
    expect(acknowledgeNotification).not.toHaveBeenCalled()
    expect(showNotification).not.toHaveBeenCalled()
  },
)

test('hidden pages leave server delivery intact', async () => {
  const { result } = renderHook(() => usePushNotifications())
  await waitFor(() => expect(result.current.status).toBe('enabled'))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await act(() => result.current.acknowledgeSessionNotification(event('agent.run.completed')))
  expect(acknowledgeNotification).not.toHaveBeenCalled()
  expect(showNotification).not.toHaveBeenCalled()
})

test('rechecks visibility after asynchronous subscription lookup', async () => {
  const { result } = renderHook(() => usePushNotifications())
  await waitFor(() => expect(result.current.status).toBe('enabled'))
  let resolveSubscription!: (value: typeof subscription) => void
  getSubscription.mockImplementationOnce(() => new Promise((resolve) => { resolveSubscription = resolve }))
  const pending = result.current.acknowledgeSessionNotification(event('agent.run.completed'))
  await waitFor(() => expect(resolveSubscription).toBeDefined())
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  resolveSubscription(subscription)
  await act(() => pending)
  expect(acknowledgeNotification).not.toHaveBeenCalled()
})

test('no subscription means no ACK, without subscribing or prompting', async () => {
  getSubscription.mockResolvedValue(null)
  const { result } = renderHook(() => usePushNotifications())
  await act(() => result.current.acknowledgeSessionNotification(event('agent.run.completed')))
  expect(acknowledgeNotification).not.toHaveBeenCalled()
  expect(savePushSubscription).not.toHaveBeenCalled()
  expect(showNotification).not.toHaveBeenCalled()
})

test.each(['default', 'denied'])('does not ACK without notification permission: %s', async (permission) => {
  vi.stubGlobal('Notification', { permission })
  const { result } = renderHook(() => usePushNotifications())
  await act(() => result.current.acknowledgeSessionNotification(event('agent.run.completed')))
  expect(getSubscription).not.toHaveBeenCalled()
  expect(acknowledgeNotification).not.toHaveBeenCalled()
})

test('unsupported browsers do not attempt notification ACKs', async () => {
  vi.stubGlobal('isSecureContext', false)
  const { result } = renderHook(() => usePushNotifications())
  expect(result.current.status).toBe('unsupported')
  await act(() => result.current.acknowledgeSessionNotification(event('agent.run.completed')))
  expect(getSubscription).not.toHaveBeenCalled()
  expect(acknowledgeNotification).not.toHaveBeenCalled()
})

test('failed ACK is best-effort with no retry or competing local alert', async () => {
  vi.mocked(acknowledgeNotification).mockRejectedValue(new TypeError('Network unavailable'))
  const { result } = renderHook(() => usePushNotifications())
  await waitFor(() => expect(result.current.status).toBe('enabled'))
  await act(() => result.current.acknowledgeSessionNotification(event('agent.run.completed')))
  expect(acknowledgeNotification).toHaveBeenCalledTimes(1)
  expect(showNotification).not.toHaveBeenCalled()
  expect(result.current.error).toBe('')
})

test('explicit local notification testing remains available', async () => {
  const { result } = renderHook(() => usePushNotifications())
  await waitFor(() => expect(result.current.status).toBe('enabled'))
  await act(() => result.current.sendLocalTest())
  expect(showNotification).toHaveBeenCalledExactlyOnceWith('Gorchestra notifications enabled', expect.objectContaining({ tag: 'gorchestra-local-test' }))
  expect(acknowledgeNotification).not.toHaveBeenCalled()
})

function event(type: string): AgentEvent {
  return { id: 'evt_8', session_id: 'sess_1', seq: 8, type, role: 'assistant', status: 'completed', payload: {}, created_at: new Date().toISOString() }
}
