import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Bell, BellOff, BellRing, Volume2, VolumeX } from 'lucide-react'
import type { NotificationStatus } from '@/hooks/use-push-notifications'
import type { Session } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Props = {
  notifications: Session[]
  supported: boolean
  status: NotificationStatus
  error: string
  soundEnabled: boolean
  dismissing: boolean
  onSelectSession: (sessionID: string) => void
  onDismissAll: () => Promise<void> | void
  onEnable: () => void
  onDisable: () => void
  onSoundEnabledChange: (enabled: boolean) => void
}

const settingItemClass =
  'flex min-h-11 cursor-default select-none items-center gap-3 rounded-md px-2.5 py-2 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground'

export function NotificationsPopover({
  notifications,
  supported,
  status,
  error,
  soundEnabled,
  dismissing,
  onSelectSession,
  onDismissAll,
  onEnable,
  onDisable,
  onSoundEnabledChange,
}: Props) {
  const count = notifications.length
  const enabled = status === 'enabled'
  const enabling = status === 'enabling'
  const denied = status === 'denied'
  const notificationToggleDisabled = !supported || denied || enabling

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          aria-label={count === 0 ? 'Notifications' : `Notifications, ${count} unread`}
          size="icon"
          variant="outline"
          className="relative shadow-sm"
        >
          <Bell />
          {count > 0 ? (
            <Badge
              aria-hidden="true"
              variant="warning"
              className="pointer-events-none absolute -right-1.5 -top-1.5 min-h-4 min-w-4 justify-center rounded-full border-background bg-[hsl(var(--warning))] px-1 py-0 text-[9px] leading-none text-black shadow-sm tabular-nums"
            >
              {count > 99 ? '99+' : count}
            </Badge>
          ) : null}
        </Button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
        >
          <div className="px-2.5 py-2">
            <p className="text-sm font-semibold">Notifications</p>
            <p className="text-xs text-muted-foreground">
              {count === 0 ? 'No unread activity' : `${count} unread ${count === 1 ? 'run' : 'runs'}`}
            </p>
          </div>

          <DropdownMenu.Separator className="my-1 h-px bg-border/70" />

          {count > 0 ? (
            <div className="max-h-64 overflow-y-auto py-0.5">
              {notifications.map((session) => (
                <DropdownMenu.Item
                  key={session.id}
                  aria-label={`Open notification for ${session.title || 'Untitled session'}`}
                  onSelect={() => onSelectSession(session.id)}
                  className="flex cursor-default select-none items-start gap-3 rounded-md px-2.5 py-2.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                >
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--warning)/0.12)] text-[hsl(var(--warning))]">
                    <BellRing className="size-3.5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{session.title || 'Untitled session'}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {notificationSummary(session)} · {formatNotificationTime(session.completed_at ?? session.updated_at)}
                    </span>
                  </span>
                </DropdownMenu.Item>
              ))}
            </div>
          ) : (
            <div className="px-3 py-5 text-center">
              <Bell className="mx-auto size-5 text-muted-foreground/70" aria-hidden="true" />
              <p className="mt-2 text-sm font-medium">You’re all caught up</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Finished runs will appear here.</p>
            </div>
          )}

          {count > 0 ? (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border/70" />
              <DropdownMenu.Item
                aria-label="Dismiss all notifications"
                disabled={dismissing}
                onSelect={() => void onDismissAll()}
                className="flex min-h-9 cursor-default select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-foreground"
              >
                <BellOff className="size-4" aria-hidden="true" />
                {dismissing ? 'Dismissing notifications…' : 'Dismiss all notifications'}
              </DropdownMenu.Item>
            </>
          ) : null}

          <DropdownMenu.Separator className="my-1 h-px bg-border/70" />
          <DropdownMenu.Label className="px-2.5 pb-1 pt-2 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Settings
          </DropdownMenu.Label>

          <DropdownMenu.CheckboxItem
            checked={enabled}
            disabled={notificationToggleDisabled}
            onCheckedChange={() => (enabled ? onDisable() : onEnable())}
            onSelect={(event) => event.preventDefault()}
            className={settingItemClass}
          >
            {enabled ? (
              <Bell className="size-4 text-muted-foreground" aria-hidden="true" />
            ) : (
              <BellOff className="size-4 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="flex-1">Browser alerts</span>
            <Badge
              variant={enabled ? 'success' : status === 'error' ? 'destructive' : 'secondary'}
              className="min-h-5 px-1.5 py-0 text-[0.68rem]"
            >
              {notificationStatusLabel(status)}
            </Badge>
            <SwitchIndicator active={enabled} />
          </DropdownMenu.CheckboxItem>

          <DropdownMenu.CheckboxItem
            checked={soundEnabled}
            onCheckedChange={(checked) => onSoundEnabledChange(checked === true)}
            onSelect={(event) => event.preventDefault()}
            className={settingItemClass}
          >
            {soundEnabled ? (
              <Volume2 className="size-4 text-muted-foreground" aria-hidden="true" />
            ) : (
              <VolumeX className="size-4 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="flex-1">Sound</span>
            <SwitchIndicator active={soundEnabled} />
          </DropdownMenu.CheckboxItem>

          <p
            className={cn(
              'mx-2.5 mb-2 mt-1 text-xs leading-4 text-muted-foreground',
              error && 'rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-destructive',
            )}
          >
            {error || notificationMessage(status, supported)}
          </p>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function SwitchIndicator({ active }: { active: boolean }) {
  return (
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
  )
}

function notificationSummary(session: Session) {
  if (session.status === 'failed') return 'Run failed'
  return 'Run finished'
}

function formatNotificationTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function notificationStatusLabel(status: NotificationStatus) {
  switch (status) {
    case 'enabled':
      return 'On'
    case 'enabling':
      return 'Enabling'
    case 'unsupported':
      return 'Unavailable'
    case 'denied':
      return 'Blocked'
    case 'error':
      return 'Error'
    default:
      return 'Off'
  }
}

function notificationMessage(status: NotificationStatus, supported: boolean) {
  if (!supported || status === 'unsupported') {
    return 'This browser cannot receive Gorchestra push notifications.'
  }
  if (status === 'denied') {
    return 'Browser permission is blocked. Update site permissions to enable alerts.'
  }
  if (status === 'enabled') {
    return 'This browser will alert you when a running session stops.'
  }
  if (status === 'error') {
    return 'Notifications need attention before they can be enabled.'
  }
  return 'Enable alerts for completed, failed, and cancelled sessions.'
}
