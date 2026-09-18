import { useEffect, useState, type FormEvent } from 'react'
import type { AgentType, PermissionPolicy, Session, SessionAgentOptions } from '@/lib/api'
import { isAgentType } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { WorkspacePicker } from '@/components/workspace-picker'
import { PermissionPolicyControl } from '@/components/permission-policy-control'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentSession?: Session | null
  onCreate: (params: {
    agent_type: AgentType
    title?: string
    workspace_path?: string
    agent_options?: SessionAgentOptions
    parent_session_id?: string
  }) => Promise<Session>
}

export function CreateSessionDialog({ open, onOpenChange, parentSession = null, onCreate }: Props) {
  const [agentType, setAgentType] = useState<AgentType>('codex')
  const [title, setTitle] = useState('')
  const [workspacePath, setWorkspacePath] = useState('')
  const [permissionPolicy, setPermissionPolicy] = useState<PermissionPolicy>('ask')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const initialAgentType = parentSession?.agent_type ?? 'codex'
  const initialPermissionPolicy = parentSession ? permissionPolicyForSession(parentSession) : 'ask'

  useEffect(() => {
    if (!open) return
    setAgentType(initialAgentType)
    setTitle('')
    setWorkspacePath('')
    setPermissionPolicy(initialPermissionPolicy)
    setError('')
  }, [initialAgentType, initialPermissionPolicy, open, parentSession?.id])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!isAgentType(agentType)) {
      setError('Choose a supported agent.')
      return
    }

    setSubmitting(true)
    setError('')
    try {
      const params: Parameters<typeof onCreate>[0] = {
        agent_type: agentType,
        title: title.trim() || undefined,
        agent_options: agentOptionsForCreate(agentType, permissionPolicy),
      }
      if (parentSession) {
        params.parent_session_id = parentSession.id
      } else {
        params.workspace_path = workspacePath || undefined
      }
      await onCreate(params)
      setTitle('')
      setAgentType('codex')
      setPermissionPolicy('ask')
      onOpenChange(false)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create session')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{parentSession ? 'Create child session' : 'Create session'}</DialogTitle>
          <DialogDescription>
            {parentSession ? 'Choose the child session settings. Its workspace is inherited from the parent.' : 'Select an agent and optional title.'}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="session-title">
              Title
            </label>
            <Input
              id="session-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Refactor auth middleware"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="agent-type">
              Agent
            </label>
            <Select value={agentType} onValueChange={(value) => setAgentType(value as AgentType)}>
              <SelectTrigger id="agent-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fake">Fake</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
                <SelectItem value="claude">Claude</SelectItem>
                <SelectItem value="opencode">OpenCode</SelectItem>
                <SelectItem value="pi">Pi</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {agentType === 'codex' || agentType === 'claude' || agentType === 'opencode' ? (
            <div className="space-y-2"><label className="text-sm font-medium">Permissions</label><PermissionPolicyControl value={permissionPolicy} onChange={setPermissionPolicy} /></div>
          ) : null}
          {parentSession ? (
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="session-workspace">
                Workspace
              </label>
              <Input id="session-workspace" value={parentSession.workspace_path} readOnly aria-readonly="true" />
            </div>
          ) : (
            <WorkspacePicker onPathChange={setWorkspacePath} disabled={submitting} />
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Creating' : 'Create'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function agentOptionsForCreate(agentType: AgentType, permissionPolicy: PermissionPolicy): SessionAgentOptions | undefined {
  if (agentType === 'codex') {
    return { codex: { permission_policy: permissionPolicy } }
  }
  if (agentType === 'claude') {
    return { claude: { permission_policy: permissionPolicy } }
  }
  if (agentType === 'opencode') return { opencode: { permission_policy: permissionPolicy } }
  return undefined
}

function permissionPolicyForSession(session: Session): PermissionPolicy {
  const options = session.agent_type === 'codex'
    ? session.agent_options?.codex
    : session.agent_type === 'claude'
      ? session.agent_options?.claude
      : session.agent_type === 'opencode'
        ? session.agent_options?.opencode
        : undefined
  if (options?.permission_policy) return options.permission_policy
  if ('run_dangerously' in (options ?? {}) && (options as { run_dangerously?: boolean }).run_dangerously) return 'bypass'
  return 'deny'
}
