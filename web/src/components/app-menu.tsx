import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Bell,
  Check,
  ExternalLink,
  Info,
  Monitor,
  Moon,
  Settings2,
  Sun,
} from 'lucide-react'
import type { NotificationStatus } from '@/hooks/use-push-notifications'
import type { ThemePreference } from '@/hooks/use-theme'
import type { ReleaseUpdate } from '@/lib/releases'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Props = {
  themePreference: ThemePreference
  onThemeChange: (preference: ThemePreference) => void
  notificationStatus: NotificationStatus
  onOpenNotifications: () => void
  release: ReleaseUpdate & { checking: boolean }
}

const menuItemClass =
  'flex min-h-10 cursor-default select-none items-center gap-3 rounded-md px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground'

const themes: Array<{
  value: ThemePreference
  label: string
  icon: typeof Monitor
}> = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

export function AppMenu({
  themePreference,
  onThemeChange,
  notificationStatus,
  onOpenNotifications,
  release,
}: Props) {
  const versionLabel = release.currentVersion === 'dev' ? 'Development build' : `Version ${release.currentVersion}`

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          aria-label={release.updateAvailable ? 'App menu, update available' : 'App menu'}
          size="icon"
          variant="outline"
          className="relative shadow-sm"
        >
          <Settings2 />
          {release.updateAvailable ? (
            <span
              role="img"
              aria-label="Update available"
              className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-background bg-[hsl(var(--warning))]"
            />
          ) : null}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 w-72 overflow-hidden rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
        >
          <div className="mb-1 rounded-md border border-border/70 bg-background/55 p-3">
            <div className="flex items-start gap-3">
              <img src="/icon.svg" alt="" className="sidebar-logo-mark mt-0.5 size-9 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold leading-5">Gorchestra</p>
                  {release.updateAvailable && release.latestVersion ? (
                    <Badge variant="warning" className="min-h-5 px-1.5 py-0 text-[0.68rem]">
                      v{release.latestVersion} available
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {versionLabel}
                  {release.checking ? ' · Checking for updates…' : ''}
                </p>
              </div>
            </div>
          </div>

          <DropdownMenu.Label className="px-2.5 pb-1 pt-2 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Appearance
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={themePreference}
            onValueChange={(value) => onThemeChange(value as ThemePreference)}
          >
            {themes.map(({ value, label, icon: Icon }) => (
              <DropdownMenu.RadioItem key={value} value={value} className={menuItemClass}>
                <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                <span className="flex-1">{label}</span>
                <DropdownMenu.ItemIndicator>
                  <Check className="size-4" aria-hidden="true" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>

          <DropdownMenu.Separator className="my-1.5 h-px bg-border/70" />

          <DropdownMenu.Item className={menuItemClass} onSelect={onOpenNotifications}>
            <Bell className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="flex-1">Notifications</span>
            <Badge
              variant={notificationStatus === 'enabled' ? 'success' : 'secondary'}
              className="min-h-5 px-1.5 py-0 text-[0.68rem]"
            >
              {notificationStatusLabel(notificationStatus)}
            </Badge>
          </DropdownMenu.Item>

          {release.updateAvailable && release.releaseURL ? (
            <DropdownMenu.Item className={menuItemClass} asChild>
              <a href={release.releaseURL} target="_blank" rel="noreferrer">
                <ExternalLink className="size-4 text-muted-foreground" aria-hidden="true" />
                <span className="flex-1">View update</span>
                <span className="text-xs text-muted-foreground">v{release.latestVersion}</span>
              </a>
            </DropdownMenu.Item>
          ) : (
            <DropdownMenu.Item
              className={cn(menuItemClass, 'text-muted-foreground')}
              asChild
            >
              <a href="https://github.com/jgennari/gorchestra/releases" target="_blank" rel="noreferrer">
                <Info className="size-4" aria-hidden="true" />
                <span className="flex-1">Release notes</span>
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
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
