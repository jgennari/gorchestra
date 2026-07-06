import type { ReactNode } from 'react'
import { Bell, BellOff, Volume2, VolumeX } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

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
  onSoundEnabledChange,
}: Props) {
  const enabled = status === 'enabled'
  const enabling = status === 'enabling'
  const denied = status === 'denied'
  const message = notificationMessage(status, supported)
  const notificationToggleDisabled = !supported || denied || enabling

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
          <SwitchRow
            label="Notifications"
            active={enabled}
            disabled={notificationToggleDisabled}
            icon={
              enabled ? (
                <Bell className="size-4" aria-hidden="true" />
              ) : (
                <BellOff className="size-4" aria-hidden="true" />
              )
            }
            onClick={enabled ? onDisable : onEnable}
          />
          <SwitchRow
            label="Sound"
            active={soundEnabled}
            disabled={false}
            icon={
              soundEnabled ? (
                <Volume2 className="size-4" aria-hidden="true" />
              ) : (
                <VolumeX className="size-4" aria-hidden="true" />
              )
            }
            onClick={() => onSoundEnabledChange(!soundEnabled)}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SwitchRow({
  label,
  active,
  disabled,
  icon,
  onClick,
}: {
  label: string
  active: boolean
  disabled: boolean
  icon: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={active}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-12 w-full items-center justify-between gap-3 rounded-md border border-border/70 bg-background/60 px-3 py-2 text-sm font-semibold text-foreground/82 transition-colors hover:bg-surface-muted/55 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      <span className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <span
        className={cn(
          'relative inline-flex h-4 w-7 shrink-0 rounded-full border transition-colors',
          active ? 'border-primary/50 bg-primary' : 'border-border/80 bg-surface-muted',
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            'absolute top-1/2 size-3 -translate-y-1/2 rounded-full bg-background shadow-sm transition-transform',
            active ? 'translate-x-3.5' : 'translate-x-0.5',
          )}
        />
      </span>
    </button>
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
