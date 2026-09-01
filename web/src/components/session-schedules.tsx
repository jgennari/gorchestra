import { CalendarClock, ChevronDown, ChevronUp, Clock3, Pause, Pencil, Play, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  cancelScheduleOccurrence,
  createSchedule,
  deleteSchedule,
  listScheduleOccurrences,
  listSchedules,
  runScheduleNow,
  updateSchedule,
  type ScheduleCadence,
  type ScheduleInput,
  type ScheduleOccurrence,
  type Session,
  type SessionSchedule,
} from '@/lib/api'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

const weekdays = [
  ['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun'],
] as const

type FormState = {
  name: string
  prompt: string
  kind: ScheduleCadence['kind']
  every: number
  unit: 'minutes' | 'hours' | 'days'
  time: string
  weekdays: string[]
  expression: string
  timezone: string
  enabled: boolean
}

export function SessionSchedules({
  session,
  resolvingSessionID,
  refreshKey = 0,
}: {
  session: Session | null
  resolvingSessionID?: string | null
  refreshKey?: number
}) {
  const [schedules, setSchedules] = useState<SessionSchedule[]>([])
  const [occurrences, setOccurrences] = useState<Record<string, ScheduleOccurrence[]>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [editingID, setEditingID] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<FormState>(() => emptyForm())
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const sessionID = session?.id ?? null
  const load = useCallback(async () => {
    if (!sessionID) return
    try {
      const next = await listSchedules(sessionID)
      setSchedules(next)
      const histories = await Promise.all(next.map(async (item) => [item.id, await listScheduleOccurrences(sessionID, item.id, 20)] as const))
      setOccurrences(Object.fromEntries(histories))
      setError('')
    } catch (loadError) {
      setError(errorMessage(loadError))
    }
  }, [sessionID])

  useEffect(() => {
    setSchedules([])
    setOccurrences({})
    setCreating(false)
    setEditingID(null)
    if (sessionID) void load()
  }, [sessionID, load])

  useEffect(() => {
    if (sessionID && refreshKey > 0) void load()
  }, [refreshKey, sessionID, load])

  const save = async () => {
    if (!sessionID) return
    setBusy('save')
    try {
      const input = formInput(form)
      if (editingID) await updateSchedule(sessionID, editingID, input)
      else await createSchedule(sessionID, input)
      setCreating(false)
      setEditingID(null)
      setForm(emptyForm())
      await load()
    } catch (saveError) {
      setError(errorMessage(saveError))
    } finally {
      setBusy('')
    }
  }

  const perform = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key)
    try {
      await action()
      await load()
      setError('')
    } catch (actionError) {
      setError(errorMessage(actionError))
    } finally {
      setBusy('')
    }
  }

  if (!session) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{resolvingSessionID ? 'Loading schedules…' : 'Select a session'}</div>
  }

  const archived = Boolean(session.archived_at)
  return (
    <div className="session-schedules-body flex h-full min-h-0 flex-col overflow-y-auto px-3 pb-3">
      <div className="flex min-h-0 w-full flex-1 flex-col gap-3 pb-16">
        <section className="shrink-0 rounded-lg border border-border/80 bg-background/72 p-4 shadow-sm" aria-labelledby="scheduled-tasks-heading">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <CalendarClock className="size-5 text-primary" aria-hidden="true" />
                <h1 id="scheduled-tasks-heading" className="text-base font-semibold">Scheduled tasks</h1>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Prompts fire at their due time and continue on this session’s main thread.</p>
            </div>
            <Button size="sm" onClick={() => { setCreating(true); setEditingID(null); setForm(emptyForm()) }} disabled={archived || creating || Boolean(editingID)}><Plus />New schedule</Button>
          </div>

          {archived ? <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">Archived sessions cannot run schedules. Restored schedules remain paused until resumed.</div> : null}
          {error ? <div role="alert" className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
        </section>

        {creating ? <ScheduleEditor form={form} setForm={setForm} saving={busy === 'save'} onSave={() => void save()} onCancel={() => setCreating(false)} /> : null}

        {schedules.length === 0 && !creating ? (
          <div className="rounded-lg border border-border/80 bg-background/72 p-10 text-center shadow-sm"><Clock3 className="mx-auto mb-3 size-7 text-muted-foreground" /><p className="font-medium">No scheduled tasks</p><p className="mt-1 text-sm text-muted-foreground">Create one to run a recurring prompt while Gorchestra is online.</p></div>
        ) : null}

        {schedules.map((schedule) => {
          const history = occurrences[schedule.id] ?? []
          const isExpanded = Boolean(expanded[schedule.id])
          const isEditing = editingID === schedule.id
          return (
            <section key={schedule.id} className="overflow-hidden rounded-lg border border-border/80 bg-card shadow-sm">
                {isEditing ? (
                  <div className="p-4"><ScheduleEditor form={form} setForm={setForm} saving={busy === 'save'} onSave={() => void save()} onCancel={() => setEditingID(null)} /></div>
                ) : (
                  <>
                    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{schedule.name}</h3><Badge variant={schedule.enabled ? 'success' : 'outline'}>{schedule.enabled ? 'Active' : 'Paused'}</Badge>{schedule.pending_count > 0 ? <Badge variant="secondary">{schedule.pending_count} queued</Badge> : null}</div>
                        <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-muted-foreground">{schedule.prompt}</p>
                        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>{cadenceLabel(schedule.cadence)}</span><span>{schedule.timezone}</span><span>{schedule.next_run_at ? `Next ${formatDate(schedule.next_run_at)}` : 'No next run'}</span>{schedule.last_status ? <span>Last: {schedule.last_status}</span> : null}</div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" disabled={Boolean(busy) || archived} onClick={() => void perform(`run-${schedule.id}`, () => runScheduleNow(session.id, schedule.id))}><Play />Run now</Button>
                        <Button size="sm" variant="outline" disabled={Boolean(busy) || archived} onClick={() => void perform(`toggle-${schedule.id}`, () => updateSchedule(session.id, schedule.id, { ...scheduleInput(schedule), enabled: !schedule.enabled }))}>{schedule.enabled ? <Pause /> : <Play />}{schedule.enabled ? 'Pause' : 'Resume'}</Button>
                        <Button size="icon" variant="ghost" aria-label={`Edit ${schedule.name}`} disabled={Boolean(busy) || archived} onClick={() => { setEditingID(schedule.id); setCreating(false); setForm(formFromSchedule(schedule)) }}><Pencil /></Button>
                        <Button size="icon" variant="ghost" aria-label={`Delete ${schedule.name}`} disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Delete “${schedule.name}” and cancel its queued runs?`)) void perform(`delete-${schedule.id}`, () => deleteSchedule(session.id, schedule.id)) }}><Trash2 /></Button>
                      </div>
                    </div>
                    <button type="button" className="flex w-full items-center justify-between border-t border-border/70 px-4 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-muted/40" onClick={() => setExpanded((current) => ({ ...current, [schedule.id]: !isExpanded }))}><span>Recent runs ({history.length})</span>{isExpanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}</button>
                    {isExpanded ? <OccurrenceHistory items={history} busy={busy} onCancel={(item) => void perform(`cancel-${item.id}`, () => cancelScheduleOccurrence(session.id, schedule.id, item.id))} /> : null}
                  </>
                )}
            </section>
          )
        })}
      </div>
    </div>
  )
}

function ScheduleEditor({ form, setForm, saving, onSave, onCancel }: { form: FormState; setForm: (value: FormState | ((current: FormState) => FormState)) => void; saving: boolean; onSave: () => void; onCancel: () => void }) {
  const valid = form.prompt.trim() && form.timezone.trim() && (form.kind !== 'cron' || form.expression.trim()) && (form.kind !== 'weekly' || form.weekdays.length > 0)
  return (
    <div className="rounded-lg border border-border/80 bg-muted/20 p-4">
      <div className="mb-4 flex items-center justify-between"><h3 className="font-semibold">Schedule details</h3><Button size="icon" variant="ghost" aria-label="Close schedule editor" onClick={onCancel}><X /></Button></div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Name"><Input value={form.name} placeholder="Optional — derived from prompt" onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></Field>
        <Field label="Timezone"><Input list="schedule-timezones" value={form.timezone} onChange={(event) => setForm((current) => ({ ...current, timezone: event.target.value }))} /><datalist id="schedule-timezones">{timezones().map((zone) => <option value={zone} key={zone} />)}</datalist></Field>
        <div className="md:col-span-2"><Field label="Prompt"><Textarea className="min-h-32 resize-y" value={form.prompt} onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))} /></Field></div>
        <Field label="Cadence type"><NativeSelect value={form.kind} onChange={(value) => setForm((current) => ({ ...current, kind: value as FormState['kind'] }))}><option value="interval">Interval</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="cron">Advanced cron</option></NativeSelect></Field>
        {form.kind === 'interval' ? <Field label="Every"><div className="grid grid-cols-[1fr_1.4fr] gap-2"><Input type="number" min={1} value={form.every} onChange={(event) => setForm((current) => ({ ...current, every: Math.max(1, Number(event.target.value)) }))} /><NativeSelect value={form.unit} onChange={(value) => setForm((current) => ({ ...current, unit: value as FormState['unit'] }))}><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option></NativeSelect></div></Field> : null}
        {form.kind === 'daily' || form.kind === 'weekly' ? <Field label="Time"><Input type="time" value={form.time} onChange={(event) => setForm((current) => ({ ...current, time: event.target.value }))} /></Field> : null}
        {form.kind === 'cron' ? <Field label="Five-field cron"><Input className="font-mono" placeholder="0 9 * * 1-5" value={form.expression} onChange={(event) => setForm((current) => ({ ...current, expression: event.target.value }))} /></Field> : null}
        {form.kind === 'weekly' ? <div className="md:col-span-2"><span className="mb-1.5 block text-xs font-medium">Weekdays</span><div className="flex flex-wrap gap-2">{weekdays.map(([value, label]) => <label key={value} className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border/80 bg-background px-2.5 py-2 text-xs"><input type="checkbox" checked={form.weekdays.includes(value)} onChange={() => setForm((current) => ({ ...current, weekdays: current.weekdays.includes(value) ? current.weekdays.filter((day) => day !== value) : [...current.weekdays, value] }))} />{label}</label>)}</div></div> : null}
      </div>
      <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))} />Active after saving</label>
      <div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={onCancel}>Cancel</Button><Button disabled={!valid || saving} onClick={onSave}>{saving ? 'Saving…' : 'Save schedule'}</Button></div>
    </div>
  )
}

function OccurrenceHistory({ items, busy, onCancel }: { items: ScheduleOccurrence[]; busy: string; onCancel: (item: ScheduleOccurrence) => void }) {
  if (items.length === 0) return <div className="border-t border-border/70 px-4 py-5 text-sm text-muted-foreground">No runs yet.</div>
  return <div className="divide-y divide-border/70 border-t border-border/70">{items.map((item) => <div key={item.id} className="flex items-center gap-3 px-4 py-3 text-sm"><Badge variant={occurrenceVariant(item.status)}>{item.status}</Badge><div className="min-w-0 flex-1"><p>{formatDate(item.scheduled_for)}</p><p className="text-xs text-muted-foreground">{item.trigger === 'manual' ? 'Run now' : 'Scheduled'}{item.error ? ` · ${item.error}` : ''}</p></div>{item.status === 'queued' ? <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => onCancel(item)}>Cancel</Button> : null}</div>)}</div>
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block"><span className="mb-1.5 block text-xs font-medium">{label}</span>{children}</label> }
function NativeSelect({ value, onChange, children }: { value: string; onChange: (value: string) => void; children: ReactNode }) { return <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring" value={value} onChange={(event) => onChange(event.target.value)}>{children}</select> }

function emptyForm(): FormState { return { name: '', prompt: '', kind: 'daily', every: 1, unit: 'hours', time: '09:00', weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'], expression: '0 9 * * 1-5', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', enabled: true } }
function formFromSchedule(item: SessionSchedule): FormState { const base = emptyForm(); const cadence = item.cadence; return { ...base, name: item.name, prompt: item.prompt, kind: cadence.kind, timezone: item.timezone, enabled: item.enabled, every: cadence.kind === 'interval' ? cadence.every : base.every, unit: cadence.kind === 'interval' ? cadence.unit : base.unit, time: cadence.kind === 'daily' || cadence.kind === 'weekly' ? cadence.time : base.time, weekdays: cadence.kind === 'weekly' ? cadence.weekdays : base.weekdays, expression: cadence.kind === 'cron' ? cadence.expression : base.expression } }
function formInput(form: FormState): ScheduleInput { let cadence: ScheduleCadence; if (form.kind === 'interval') cadence = { kind: 'interval', every: form.every, unit: form.unit }; else if (form.kind === 'daily') cadence = { kind: 'daily', time: form.time }; else if (form.kind === 'weekly') cadence = { kind: 'weekly', time: form.time, weekdays: form.weekdays }; else cadence = { kind: 'cron', expression: form.expression }; return { name: form.name, prompt: form.prompt, cadence, timezone: form.timezone, enabled: form.enabled } }
function scheduleInput(item: SessionSchedule): ScheduleInput { return { name: item.name, prompt: item.prompt, cadence: item.cadence, timezone: item.timezone, enabled: item.enabled } }
function cadenceLabel(cadence: ScheduleCadence) { if (cadence.kind === 'interval') return `Every ${cadence.every} ${cadence.unit}`; if (cadence.kind === 'daily') return `Daily at ${cadence.time}`; if (cadence.kind === 'weekly') return `${cadence.weekdays.join(', ')} at ${cadence.time}`; return cadence.expression }
function occurrenceVariant(status: ScheduleOccurrence['status']): BadgeProps['variant'] { if (status === 'completed') return 'success'; if (status === 'failed') return 'destructive'; if (status === 'running' || status === 'queued') return 'secondary'; return 'outline' }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Schedule request failed' }
function timezones() { const current = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; const supported = (Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }).supportedValuesOf?.('timeZone') ?? []; return Array.from(new Set([current, 'UTC', ...supported])) }
