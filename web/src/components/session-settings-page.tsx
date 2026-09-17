import { Activity, BookOpen, CalendarClock, Loader2, Server, SlidersHorizontal } from 'lucide-react'
import { lazy, Suspense, type ComponentProps, type ReactNode } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { isSessionSettingsView, type SessionSettingsSection } from '@/lib/routes'

const GeneralSettings = lazy(() => import('./session-settings').then((module) => ({ default: module.SessionSettings })))
const SessionSchedules = lazy(() => import('./session-schedules').then((module) => ({ default: module.SessionSchedules })))
const RepositorySkills = lazy(() => import('./repository-skills').then((module) => ({ default: module.RepositorySkills })))
const HostPreview = lazy(() => import('./host-preview').then((module) => ({ default: module.HostPreview })))

const sections = [
  { value: 'activity', label: 'Activity', icon: Activity, mobileOnly: true },
  { value: 'settings', label: 'General', icon: SlidersHorizontal, mobileOnly: false },
  { value: 'schedules', label: 'Scheduled tasks', icon: CalendarClock, mobileOnly: false },
  { value: 'skills', label: 'Skills', icon: BookOpen, mobileOnly: false },
  { value: 'host', label: 'Hosting', icon: Server, mobileOnly: false },
] as const

type Props = ComponentProps<typeof GeneralSettings> & {
  section: SessionSettingsSection
  onSelectSection: (section: SessionSettingsSection) => void
  scheduleRefreshKey: number
  onOpenFile: (path: string) => void
  mobileSessionOverview: ReactNode
}

export function SessionSettingsPage({ section, onSelectSection, scheduleRefreshKey, onOpenFile, mobileSessionOverview, ...generalProps }: Props) {
  const { session, resolvingSessionID } = generalProps
  const panelProps = { session, resolvingSessionID, embedded: true }
  return (
    <Tabs
      value={section}
      onValueChange={(value) => {
        if (isSessionSettingsView(value)) onSelectSection(value)
      }}
      activationMode="manual"
      className="session-settings-page flex h-full min-h-0 flex-col"
    >
      <section className="mx-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/80 bg-background/72 shadow-sm" aria-label="Session settings">
        <TabsList aria-label="Session settings sections" className="grid h-auto w-full shrink-0 grid-cols-5 rounded-none border-0 border-b border-border/80 bg-surface-muted/50 p-1 lg:grid-cols-4">
          {sections.map(({ value, label, icon: Icon, mobileOnly }) => (
            <TabsTrigger key={value} value={value} className={`${mobileOnly ? 'lg:hidden ' : ''}h-auto min-h-10 gap-1.5 whitespace-normal px-1 text-center text-[11px] sm:px-2.5 sm:text-xs`}>
              <Icon className="hidden size-3.5 shrink-0 sm:block" aria-hidden="true" />{label}
            </TabsTrigger>
          ))}
        </TabsList>
        {sections.map(({ value }) => (
          <TabsContent key={value} value={value} className="min-h-0 flex-1 overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <Suspense fallback={<div role="status" className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" />Loading settings…</div>}>
              {value === 'activity' ? mobileSessionOverview
                : value === 'settings' ? <GeneralSettings key={session?.id} {...generalProps} embedded />
                : value === 'schedules' ? <SessionSchedules key={session?.id} {...panelProps} refreshKey={scheduleRefreshKey} />
                  : value === 'skills' ? <RepositorySkills key={session?.id} {...panelProps} onOpenFile={onOpenFile} />
                    : <HostPreview key={session?.id} {...panelProps} />}
            </Suspense>
          </TabsContent>
        ))}
      </section>
    </Tabs>
  )
}
