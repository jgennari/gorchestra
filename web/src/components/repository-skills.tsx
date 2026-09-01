import { AlertTriangle, BookOpen, Check, FileCode2, Link2, Menu, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  createRepositorySkill,
  createUserSkill,
  deleteRepositorySkill,
  deleteUserSkill,
  getRepositorySkill,
  getUserSkill,
  listRepositorySkills,
  listUserSkills,
  repairRepositorySkillClaudeBridge,
  repairRepositorySkillClaudeBridges,
  repairUserSkillClaudeBridge,
  repairUserSkillClaudeBridges,
  updateRepositorySkill,
  updateUserSkill,
  type RepositorySkill,
  type RepositorySkillInput,
  type Session,
} from '@/lib/api'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

type FormState = {
  currentName: string | null
  name: string
  description: string
  instructions: string
  revision?: string
}

export function RepositorySkills({
  session,
  resolvingSessionID,
  onOpenFile,
  userScope = false,
  onOpenSessions,
}: {
  session?: Session | null
  resolvingSessionID?: string | null
  onOpenFile?: (path: string) => void
  userScope?: boolean
  onOpenSessions?: () => void
}) {
  const [skills, setSkills] = useState<RepositorySkill[]>([])
  const [form, setForm] = useState<FormState | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [ignoredConflicts, setIgnoredConflicts] = useState<string[]>([])
  const [homePath, setHomePath] = useState('')
  const sessionID = session?.id ?? ''
  const scopeAvailable = userScope || Boolean(sessionID)

  const load = useCallback(async () => {
    if (!scopeAvailable) return
    setLoading(true)
    try {
      if (userScope) {
        const catalog = await listUserSkills()
        setHomePath(catalog.home_path)
        setIgnoredConflicts(readIgnoredBridgeConflicts(catalog.home_path))
        setSkills(catalog.skills)
      } else {
        setSkills(await listRepositorySkills(sessionID))
      }
      setError('')
    } catch (loadError) {
      setError(errorMessage(loadError))
    } finally {
      setLoading(false)
    }
  }, [scopeAvailable, sessionID, userScope])

  useEffect(() => {
    setSkills([])
    setForm(null)
    setError('')
    setNotice('')
    setHomePath('')
    if (!userScope) setIgnoredConflicts(readIgnoredBridgeConflicts(session?.workspace_path ?? ''))
    if (scopeAvailable) void load()
  }, [load, scopeAvailable, session?.workspace_path, sessionID, userScope])

  const setConflictIgnored = (name: string, ignored: boolean) => {
    setIgnoredConflicts((current) => {
      const next = ignored
        ? Array.from(new Set([...current, name])).sort()
        : current.filter((item) => item !== name)
      writeIgnoredBridgeConflicts(userScope ? (homePath || '~') : (session?.workspace_path ?? ''), next)
      return next
    })
  }

  const edit = async (skill: RepositorySkill) => {
    setBusy(`edit-${skill.directory_name}`)
    setError('')
    try {
      const detail = userScope
        ? await getUserSkill(skill.directory_name)
        : await getRepositorySkill(sessionID, skill.directory_name)
      setForm({
        currentName: skill.directory_name,
        name: detail.name,
        description: detail.description,
        instructions: detail.instructions ?? '',
        revision: detail.revision,
      })
    } catch (editError) {
      setError(errorMessage(editError))
    } finally {
      setBusy('')
    }
  }

  const save = async () => {
    if (!form) return
    setBusy('save')
    setError('')
    setNotice('')
    try {
      const input: RepositorySkillInput = {
        name: form.name.trim(),
        description: form.description.trim(),
        instructions: form.instructions,
        revision: form.revision,
      }
      const saved = form.currentName
        ? userScope
          ? await updateUserSkill(form.currentName, input)
          : await updateRepositorySkill(sessionID, form.currentName, input)
        : userScope
          ? await createUserSkill(input)
          : await createRepositorySkill(sessionID, input)
      setForm(null)
      setNotice(
        saved.claude_bridge.status === 'linked'
          ? `Saved ${saved.name}.`
          : `Saved ${saved.name}; its Claude bridge needs attention.`,
      )
      await load()
    } catch (saveError) {
      setError(errorMessage(saveError))
    } finally {
      setBusy('')
    }
  }

  const perform = async (key: string, action: () => Promise<unknown>, message = '') => {
    setBusy(key)
    setError('')
    setNotice('')
    try {
      await action()
      if (message) setNotice(message)
      await load()
    } catch (actionError) {
      setError(errorMessage(actionError))
    } finally {
      setBusy('')
    }
  }

  if (!userScope && !session) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{resolvingSessionID ? 'Loading skills…' : 'Select a session'}</div>
  }

  const missingBridges = skills.filter((skill) => skill.claude_bridge.status === 'missing').length
  const bridgeConflicts = skills.filter((skill) =>
    skill.claude_bridge.status === 'error' ||
    (skill.claude_bridge.status === 'conflict' && !ignoredConflicts.includes(skill.directory_name)),
  ).length
  const title = userScope ? 'User skills' : 'Repository skills'
  const skillPath = userScope
    ? `${homePath || '~'}/.agents/skills`
    : `${session?.workspace_path ?? ''}/.agents/skills`

  return (
    <div className={userScope ? 'h-full overflow-y-auto bg-background' : 'repository-skills-body flex h-full min-h-0 flex-col overflow-y-auto px-3 pb-3'}>
      <div className={userScope ? 'dashboard-overview-content mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 pb-16 sm:px-6 lg:px-8' : 'mx-auto flex w-full max-w-5xl flex-col gap-4 pb-16'}>
        <section className="shrink-0 rounded-lg border border-border/80 bg-background/72 p-4 shadow-sm" aria-labelledby="repository-skills-heading">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                {userScope && onOpenSessions ? <Button type="button" size="icon" variant="ghost" aria-label="Open sessions" onClick={onOpenSessions} className="-ml-2 shrink-0 lg:hidden"><Menu /></Button> : null}
                <BookOpen className="size-5 text-primary" aria-hidden="true" />
                <h1 id="repository-skills-heading" className="text-base font-semibold">{title}</h1>
                <Badge variant="secondary">{skills.length}</Badge>
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground" title={skillPath}>
                {skillPath}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={Boolean(busy) || missingBridges === 0}
                onClick={() => void perform('repair-all', async () => {
                  const result = userScope
                    ? await repairUserSkillClaudeBridges()
                    : await repairRepositorySkillClaudeBridges(sessionID)
                  setNotice(result.repaired === 1 ? 'Repaired 1 Claude bridge.' : `Repaired ${result.repaired} Claude bridges.`)
                })}
              >
                <RefreshCw />Repair Claude bridges
              </Button>
              <Button size="sm" disabled={Boolean(busy) || Boolean(form)} onClick={() => setForm(emptyForm())}>
                <Plus />New skill
              </Button>
            </div>
          </div>
          {bridgeConflicts > 0 ? (
            <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
              {bridgeConflicts} Claude {bridgeConflicts === 1 ? 'path has a conflict' : 'paths have conflicts'}. Existing entries were left untouched.
            </div>
          ) : null}
          {error ? <div role="alert" className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
          {notice ? <div role="status" className="mt-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">{notice}</div> : null}
        </section>

        {form ? <SkillEditor form={form} setForm={setForm} saving={busy === 'save'} onSave={() => void save()} onCancel={() => setForm(null)} /> : null}

        {!loading && skills.length === 0 && !form ? (
          <div className="rounded-lg border border-border/80 bg-background/72 p-10 text-center shadow-sm">
            <FileCode2 className="mx-auto mb-3 size-7 text-muted-foreground" />
            <p className="font-medium">No {userScope ? 'user' : 'repository'} skills</p>
            <p className="mt-1 text-sm text-muted-foreground">Create one to add a reusable instruction bundle to {userScope ? 'your account' : 'this workspace'}.</p>
          </div>
        ) : null}
        {loading && skills.length === 0 ? <div className="rounded-lg border border-border/80 bg-card p-8 text-center text-sm text-muted-foreground shadow-sm">Loading repository skills…</div> : null}

        {skills.map((skill) => {
          const conflictIgnored = skill.claude_bridge.status === 'conflict' && ignoredConflicts.includes(skill.directory_name)
          return <section key={skill.directory_name} className="rounded-lg border border-border/80 bg-card p-4 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold">{skill.name || skill.directory_name}</h2>
                  {skill.validation_errors.length === 0 ? <Badge variant="success">Valid</Badge> : <Badge variant="warning">Needs repair</Badge>}
                  <BridgeBadge skill={skill} ignored={conflictIgnored} />
                  {skill.linked ? <Badge variant="outline">Linked bundle</Badge> : null}
                </div>
                {skill.description ? <p className="mt-1 text-sm text-muted-foreground">{skill.description}</p> : null}
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-mono">{skill.path}</span>
                  <span>{skill.resource_count} supporting {skill.resource_count === 1 ? 'file' : 'files'}</span>
                  {skill.modified_at ? <span>Updated {formatDate(skill.modified_at)}</span> : null}
                </div>
                {skill.validation_errors.length > 0 ? (
                  <div className="mt-3 flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <ul className="list-inside list-disc">{skill.validation_errors.map((message) => <li key={message}>{message}</li>)}</ul>
                  </div>
                ) : null}
                {skill.claude_bridge.message && !conflictIgnored ? <p className="mt-2 text-xs text-muted-foreground">Claude: {skill.claude_bridge.message}</p> : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {!skill.editable && onOpenFile ? <Button size="sm" variant="outline" onClick={() => onOpenFile(skill.path)}><FileCode2 />Open SKILL.md</Button> : null}
                {skill.claude_bridge.status === 'missing' ? (
                  <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void perform(
                    `bridge-${skill.directory_name}`,
                    () => userScope ? repairUserSkillClaudeBridge(skill.directory_name) : repairRepositorySkillClaudeBridge(sessionID, skill.directory_name),
                    `Linked ${skill.name} for Claude.`,
                  )}><Link2 />Link Claude</Button>
                ) : null}
                {skill.claude_bridge.status === 'conflict' ? (
                  <>
                    <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => setConflictIgnored(skill.directory_name, !conflictIgnored)}>
                      {conflictIgnored ? <RefreshCw /> : <Check />}{conflictIgnored ? 'Reconsider' : 'Keep existing'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        if (!window.confirm(`Replace the existing Claude entry for “${skill.directory_name}” with a bridge? Gorchestra will move it to a timestamped backup first.`)) return
                        void perform(`replace-${skill.directory_name}`, async () => {
                          const result = userScope
                            ? await repairUserSkillClaudeBridge(skill.directory_name, true)
                            : await repairRepositorySkillClaudeBridge(sessionID, skill.directory_name, true)
                          setConflictIgnored(skill.directory_name, false)
                          setNotice(result.backup_path ? `Linked ${skill.name} for Claude. The previous entry is backed up at ${result.backup_path}.` : `Linked ${skill.name} for Claude.`)
                        })
                      }}
                    ><Link2 />Replace with bridge</Button>
                  </>
                ) : null}
                <Button size="icon" variant="ghost" aria-label={`Edit ${skill.name}`} disabled={!skill.editable || Boolean(busy) || Boolean(form)} onClick={() => void edit(skill)}><Pencil /></Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete ${skill.name || skill.directory_name}`}
                  disabled={Boolean(busy)}
                  onClick={() => {
                    const resources = skill.resource_count ? ` and ${skill.resource_count} supporting ${skill.resource_count === 1 ? 'file' : 'files'}` : ''
                    if (window.confirm(`Delete “${skill.directory_name}”${resources}? This removes the entire bundle.`)) {
                      void perform(
                        `delete-${skill.directory_name}`,
                        () => userScope ? deleteUserSkill(skill.directory_name) : deleteRepositorySkill(sessionID, skill.directory_name),
                        `Deleted ${skill.directory_name}.`,
                      )
                    }
                  }}
                ><Trash2 /></Button>
              </div>
            </div>
          </section>
        })}
      </div>
    </div>
  )
}

function SkillEditor({ form, setForm, saving, onSave, onCancel }: { form: FormState; setForm: (value: FormState | null | ((current: FormState | null) => FormState | null)) => void; saving: boolean; onSave: () => void; onCancel: () => void }) {
  const valid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(form.name.trim()) && form.name.trim().length <= 64 && form.description.trim().length > 0 && form.description.trim().length <= 1024
  const change = (key: 'name' | 'description' | 'instructions', value: string) => setForm((current) => current ? { ...current, [key]: value } : current)
  return (
    <section className="rounded-lg border border-border/80 bg-card p-4 shadow-sm" aria-labelledby="skill-editor-heading">
      <div className="mb-4 flex items-center justify-between">
        <div><h2 id="skill-editor-heading" className="font-semibold">{form.currentName ? 'Edit repository skill' : 'New repository skill'}</h2><p className="mt-1 text-xs text-muted-foreground">Supporting files in this bundle are preserved when you edit or rename it.</p></div>
        <Button size="icon" variant="ghost" aria-label="Close skill editor" onClick={onCancel}><X /></Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Name" htmlFor="repository-skill-name"><Input id="repository-skill-name" value={form.name} maxLength={64} placeholder="review-pull-request" onChange={(event) => change('name', event.target.value)} /><p className="mt-1 text-xs text-muted-foreground">Lowercase letters, numbers, and hyphens.</p></Field>
        <Field label="Description" htmlFor="repository-skill-description"><Textarea id="repository-skill-description" className="min-h-20 resize-y" value={form.description} maxLength={1024} placeholder="Review a pull request for correctness and regressions." onChange={(event) => change('description', event.target.value)} /></Field>
        <div className="md:col-span-2"><Field label="Instructions (Markdown)" htmlFor="repository-skill-instructions"><Textarea id="repository-skill-instructions" className="min-h-72 resize-y font-mono text-sm" value={form.instructions} placeholder="# Workflow&#10;&#10;1. Inspect the changes…" onChange={(event) => change('instructions', event.target.value)} /></Field></div>
      </div>
      <div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={onCancel}>Cancel</Button><Button disabled={!valid || saving} onClick={onSave}>{saving ? 'Saving…' : 'Save skill'}</Button></div>
    </section>
  )
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return <div><label className="mb-1.5 block text-xs font-medium" htmlFor={htmlFor}>{label}</label>{children}</div>
}

function BridgeBadge({ skill, ignored = false }: { skill: RepositorySkill; ignored?: boolean }) {
  if (ignored) return <Badge variant="outline">Claude kept existing</Badge>
  const status = skill.claude_bridge.status
  const variant: BadgeProps['variant'] = status === 'linked' ? 'success' : status === 'missing' ? 'outline' : 'warning'
  return <Badge variant={variant}>Claude {status}</Badge>
}

function emptyForm(): FormState { return { currentName: null, name: '', description: '', instructions: '# Instructions\n\n' } }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Repository skill request failed' }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) }

const ignoredBridgeConflictsStorageKey = 'gorchestra.repository-skills.ignored-claude-conflicts'

function readIgnoredBridgeConflicts(workspace: string) {
  if (!workspace) return []
  try {
    const stored = JSON.parse(window.localStorage.getItem(ignoredBridgeConflictsStorageKey) ?? '{}') as Record<string, unknown>
    const names = stored[workspace]
    return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : []
  } catch {
    return []
  }
}

function writeIgnoredBridgeConflicts(workspace: string, names: string[]) {
  if (!workspace) return
  try {
    const stored = JSON.parse(window.localStorage.getItem(ignoredBridgeConflictsStorageKey) ?? '{}') as Record<string, unknown>
    if (names.length > 0) stored[workspace] = names
    else delete stored[workspace]
    window.localStorage.setItem(ignoredBridgeConflictsStorageKey, JSON.stringify(stored))
  } catch {
    // Acknowledgement remains active for this view when storage is unavailable.
  }
}
