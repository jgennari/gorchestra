import { useState, type FormEvent } from 'react'
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
  onCreate: (params: {
    agent_type: AgentType
    title?: string
    workspace_path?: string
    agent_options?: SessionAgentOptions
  }) => Promise<Session>
}

export function CreateSessionDialog({ open, onOpenChange, onCreate }: Props) {
  const [agentType, setAgentType] = useState<AgentType>('codex')
  const [title, setTitle] = useState('')
  const [workspacePath, setWorkspacePath] = useState('')
  const [permissionPolicy, setPermissionPolicy] = useState<PermissionPolicy>('ask')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!isAgentType(agentType)) {
      setError('Choose a supported agent.')
      return
    }

    setSubmitting(true)
    setError('')
    try {
      await onCreate({
        agent_type: agentType,
        title: title.trim() || undefined,
        workspace_path: workspacePath || undefined,
        agent_options: agentOptionsForCreate(agentType, permissionPolicy),
      })
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
          <DialogTitle>Create session</DialogTitle>
          <DialogDescription>Select an agent and optional title.</DialogDescription>
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
          <WorkspacePicker onPathChange={setWorkspacePath} disabled={submitting} />
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
