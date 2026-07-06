import { Bell, BellOff, Volume2, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

type NotificationStatus = 'unsupported' | 'default' | 'denied' | 'enabling' | 'enabled' | 'error'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  supported: boolean
  status: NotificationStatus
  error: string
  soundEnabled: boolean
  onEnable: () => void
  onDisable: () => void
  onSendTest: () => void
  onSoundEnabledChange: (enabled: boolean) => void
}

export function NotificationsDialog({
  open,
  onOpenChange,
  supported,
  status,
  error,
  soundEnabled,
  onEnable,
  onDisable,
  onSendTest,
  onSoundEnabledChange,
}: Props) {
  const enabled = status === 'enabled'
  const enabling = status === 'enabling'
  const denied = status === 'denied'
  const message = notificationMessage(status, supported)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-4 border-border/90 p-5">
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

          <Button type="button" variant="outline" onClick={onSendTest} disabled={!enabled}>
            <Bell />
            Send test
          </Button>
        </div>

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
      </DialogContent>
    </Dialog>
  )
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
