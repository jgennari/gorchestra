import { Bell, BellOff, RefreshCw, Volume2, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { PushNotificationDebug } from '@/hooks/use-push-notifications'

type NotificationStatus = 'unsupported' | 'default' | 'denied' | 'enabling' | 'enabled' | 'error'
type NotificationTestState = 'idle' | 'sending' | 'sent'
type BadgeTestState = 'idle' | 'setting' | 'set' | 'clearing' | 'cleared' | 'unsupported' | 'error'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  supported: boolean
  status: NotificationStatus
  error: string
  testState: NotificationTestState
  localTestState: NotificationTestState
  badgeTestState: BadgeTestState
  badgeTestMessage: string
  debug: PushNotificationDebug | null
  soundEnabled: boolean
  onEnable: () => void
  onDisable: () => void
  onSendTest: () => void
  onSendLocalTest: () => void
  onSetBadge: () => void
  onClearBadge: () => void
  onRefreshDebug: () => void
  onSoundEnabledChange: (enabled: boolean) => void
}

export function NotificationsDialog({
  open,
  onOpenChange,
  supported,
  status,
  error,
  testState,
  localTestState,
  badgeTestState,
  badgeTestMessage,
  debug,
  soundEnabled,
  onEnable,
  onDisable,
  onSendTest,
  onSendLocalTest,
  onSetBadge,
  onClearBadge,
  onRefreshDebug,
  onSoundEnabledChange,
}: Props) {
  const enabled = status === 'enabled'
  const enabling = status === 'enabling'
  const denied = status === 'denied'
  const sendingTest = testState === 'sending'
  const sendingLocalTest = localTestState === 'sending'
  const settingBadge = badgeTestState === 'setting'
  const clearingBadge = badgeTestState === 'clearing'
  const message = notificationMessage(status, supported)
  const serverSubscription = debug?.server?.subscriptions[0] ?? null
  const lastAttempt = debug?.server?.recent_attempts[0] ?? null
  const workerDiagnostic = debug?.worker ?? null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-4 border-border/90 p-5">
        <DialogHeader>
          <DialogTitle>Notifications</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="grid gap-2">
          {enabled ? (
            <Button type="button" variant="outline" onClick={onDisable}>
              <BellOff />
              Disable notifications
            </Button>
          ) : (
            <Button type="button" onClick={onEnable} disabled={!supported || denied || enabling}>
              <Bell />
              {enabling ? 'Enabling...' : 'Enable notifications'}
            </Button>
          )}

          <Button type="button" variant="outline" onClick={onSendTest} disabled={sendingTest}>
            <Bell />
            {sendingTest ? 'Sending...' : 'Send remote push'}
          </Button>

          <Button type="button" variant="outline" onClick={onSendLocalTest} disabled={sendingLocalTest}>
            <Bell />
            {sendingLocalTest ? 'Showing...' : 'Show local notification'}
          </Button>

          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" onClick={onSetBadge} disabled={settingBadge}>
              <Bell />
              {settingBadge ? 'Setting...' : 'Set badge'}
            </Button>
            <Button type="button" variant="outline" onClick={onClearBadge} disabled={clearingBadge}>
              <BellOff />
              {clearingBadge ? 'Clearing...' : 'Clear badge'}
            </Button>
          </div>
        </div>

        {testState === 'sent' || localTestState === 'sent' || badgeTestMessage ? (
          <p className="rounded-md border border-border/70 bg-background/60 px-3 py-2 text-sm text-muted-foreground">
            {badgeTestMessage || (testState === 'sent' ? 'Remote push sent.' : 'Local notification shown.')}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-background/60 px-3 py-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            {soundEnabled ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
            Sound
          </div>
          <Button
            type="button"
            size="sm"
            variant={soundEnabled ? 'secondary' : 'outline'}
            onClick={() => onSoundEnabledChange(!soundEnabled)}
          >
            {soundEnabled ? 'On' : 'Off'}
          </Button>
        </div>

        <div className="grid gap-2 rounded-md border border-border/70 bg-background/60 p-3 text-xs text-muted-foreground">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-foreground">Diagnostics</span>
            <Button type="button" size="sm" variant="ghost" onClick={onRefreshDebug}>
              <RefreshCw className="size-3.5" />
              Refresh
            </Button>
          </div>
          <DebugRow label="Origin" value={debug?.browser.origin || 'unknown'} />
          <DebugRow label="Display" value={debug?.browser.display_mode || 'unknown'} />
          <DebugRow label="Permission" value={debug?.browser.permission || 'unknown'} />
          <DebugRow label="Service worker" value={debug?.browser.service_worker_state || 'unknown'} />
          <DebugRow label="Badging" value={debug?.browser.app_badge_supported ? 'supported' : 'not supported'} />
          <DebugRow label="Browser sub" value={debug?.browser.current_subscription_hash || 'none'} />
          <DebugRow
            label="Server sub"
            value={
              serverSubscription
                ? `${serverSubscription.endpoint_hash} ${serverSubscription.origin || 'no-origin'}`
                : 'none'
            }
          />
          <DebugRow
            label="Last push"
            value={
              lastAttempt
                ? `${lastAttempt.response_status || lastAttempt.error || 'pending'} ${shortTime(lastAttempt.created_at)}`
                : 'none'
            }
          />
          <DebugRow label="Worker push" value={workerPushValue(workerDiagnostic)} />
          <DebugRow label="Worker badge" value={workerBadgeValue(workerDiagnostic)} />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function workerPushValue(worker: PushNotificationDebug['worker']) {
  if (!worker) {
    return 'none'
  }
  const mode = worker.declarative ? 'declarative' : 'showNotification'
  const shown = worker.showNotification?.attempted
    ? worker.showNotification.ok
      ? 'shown'
      : `show failed${worker.showNotification.error ? `: ${worker.showNotification.error}` : ''}`
    : (worker.showNotification?.reason ?? 'not shown')
  const time = worker.createdAt ? shortTime(new Date(worker.createdAt).toISOString()) : 'unknown'
  return `${mode}, ${shown}, ${time}`
}

function workerBadgeValue(worker: PushNotificationDebug['worker']) {
  if (!worker?.badge) {
    return 'none'
  }
  if (!worker.badge.supported) {
    return 'not supported in worker'
  }
  if (!worker.badge.attempted) {
    return 'not attempted'
  }
  if (worker.badge.ok) {
    return `set ${worker.badge.count ?? 1}`
  }
  return `failed${worker.badge.error ? `: ${worker.badge.error}` : ''}`
}

function DebugRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
      <span>{label}</span>
      <span className="min-w-0 break-words font-mono text-foreground/90">{value}</span>
    </div>
  )
}

function shortTime(value: string) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return value
  }
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function notificationMessage(status: NotificationStatus, supported: boolean) {
  if (!supported || status === 'unsupported') {
    return 'This browser cannot receive Gorchestra push notifications.'
  }
  if (status === 'denied') {
    return 'Browser permission is blocked. Update site permissions to enable alerts.'
  }
  if (status === 'enabled') {
    return 'Gorchestra will notify this browser when any running session stops.'
  }
  if (status === 'error') {
    return 'Notifications need attention before they can be enabled.'
  }
  return 'Enable alerts for completed, failed, and cancelled sessions.'
}
