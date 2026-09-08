import { BookOpen, CalendarClock, Loader2, Server, Settings, SlidersHorizontal } from 'lucide-react'
import { lazy, Suspense, type ComponentProps } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { isSessionSettingsView, type SessionSettingsSection } from '@/lib/routes'

const GeneralSettings = lazy(() => import('./session-settings').then((module) => ({ default: module.SessionSettings })))
const SessionSchedules = lazy(() => import('./session-schedules').then((module) => ({ default: module.SessionSchedules })))
const RepositorySkills = lazy(() => import('./repository-skills').then((module) => ({ default: module.RepositorySkills })))
const HostPreview = lazy(() => import('./host-preview').then((module) => ({ default: module.HostPreview })))

const sections = [
  { value: 'settings', label: 'General', icon: SlidersHorizontal },
  { value: 'schedules', label: 'Scheduled tasks', icon: CalendarClock },
  { value: 'skills', label: 'Skills', icon: BookOpen },
  { value: 'host', label: 'Hosting', icon: Server },
] as const

type Props = ComponentProps<typeof GeneralSettings> & {
  section: SessionSettingsSection
  onSelectSection: (section: SessionSettingsSection) => void
  scheduleRefreshKey: number
  onOpenFile: (path: string) => void
}

export function SessionSettingsPage({ section, onSelectSection, scheduleRefreshKey, onOpenFile, ...generalProps }: Props) {
  const { session, resolvingSessionID } = generalProps
  const panelProps = { session, resolvingSessionID, embedded: true }
  return (
    <Tabs
      value={section}
      onValueChange={(value) => {
        if (isSessionSettingsView(value)) onSelectSection(value)
      }}
      activationMode="manual"
      className="session-settings-page flex h-full min-h-0 flex-col gap-3"
    >
      <section className="mx-3 shrink-0 rounded-lg border border-border/80 bg-background/72 p-3 shadow-sm sm:p-4" aria-labelledby="session-settings-page-heading">
        <div className="flex items-center gap-2">
          <Settings className="size-5 text-primary" aria-hidden="true" />
          <h1 id="session-settings-page-heading" className="text-base font-semibold">Session settings</h1>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Configure this session, its scheduled tasks, repository skills, and hosting.</p>
        <TabsList aria-label="Session settings sections" className="mt-3 grid h-auto w-full grid-cols-4">
          {sections.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value} className="h-auto min-h-10 gap-1.5 whitespace-normal px-1 text-center text-[11px] sm:px-2.5 sm:text-xs">
              <Icon className="hidden size-3.5 shrink-0 sm:block" aria-hidden="true" />{label}
            </TabsTrigger>
          ))}
        </TabsList>
      </section>
      {sections.map(({ value }) => (
        <TabsContent key={value} value={value} className="min-h-0 flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Suspense fallback={<div role="status" className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" />Loading settings…</div>}>
            {value === 'settings' ? <GeneralSettings key={session?.id} {...generalProps} embedded />
              : value === 'schedules' ? <SessionSchedules key={session?.id} {...panelProps} refreshKey={scheduleRefreshKey} />
                : value === 'skills' ? <RepositorySkills key={session?.id} {...panelProps} onOpenFile={onOpenFile} />
                  : <HostPreview key={session?.id} {...panelProps} />}
          </Suspense>
        </TabsContent>
      ))}
    </Tabs>
  )
}
