import { ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import type { PendingPermissionRequest } from '@/lib/events'
import { cn } from '@/lib/utils'

export function PermissionQueue({ requests, onResolve }: { requests: PendingPermissionRequest[]; onResolve: (requestID: string, optionID: string) => Promise<void> }) {
  const [submission, setSubmission] = useState({ requestID: '', optionID: '' })
  const [resolvedRequestID, setResolvedRequestID] = useState('')
  const [requestError, setRequestError] = useState({ requestID: '', message: '' })
  if (requests.length === 0) return null
  const request = requests[0]
  if (resolvedRequestID === request.request_id) return null
  const submitting = submission.requestID === request.request_id ? submission.optionID : ''
  const error = requestError.requestID === request.request_id ? requestError.message : ''
  async function resolve(optionID: string) {
    setSubmission({ requestID: request.request_id, optionID })
    setRequestError({ requestID: '', message: '' })
    try {
      await onResolve(request.request_id, optionID)
      setResolvedRequestID(request.request_id)
    } catch (cause) {
      setRequestError({ requestID: request.request_id, message: cause instanceof Error ? cause.message : 'Failed to resolve permission' })
      setSubmission({ requestID: '', optionID: '' })
    }
  }
  const detail = request.command || (request.tool_input !== undefined ? JSON.stringify(request.tool_input, null, 2) : request.diff || (request.requested_grants !== undefined ? JSON.stringify(request.requested_grants, null, 2) : ''))
  return (
    <section role="group" aria-label="Permission required" className="mx-3 max-h-[45vh] overflow-auto rounded-lg border border-amber-500/40 bg-background/95 p-3 shadow-[0_16px_40px_hsl(var(--foreground)/0.14)] backdrop-blur">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3"><p className="text-xs font-semibold uppercase text-muted-foreground">{request.provider} permission</p>{requests.length > 1 ? <span className="text-xs tabular-nums text-muted-foreground">1/{requests.length}</span> : null}</div>
          <h3 className="mt-1 text-sm font-semibold">{request.title}</h3>
          {request.reason || request.description ? <p className="mt-1 text-xs text-muted-foreground">{request.reason || request.description}</p> : null}
          {detail ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 p-2 text-xs leading-relaxed">{detail}</pre> : null}
          {request.cwd ? <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{request.cwd}</p> : null}
          {request.paths?.length ? <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{request.paths.join(', ')}</p> : null}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {request.options.map((option) => <button key={option.id} type="button" disabled={Boolean(submitting)} onClick={() => void resolve(option.id)} className={cn('min-h-9 rounded-md border px-3 text-xs font-medium transition-colors disabled:opacity-50', option.decision === 'allow' ? 'border-primary/50 bg-primary/10 hover:bg-primary/15' : option.decision === 'cancel' ? 'border-destructive/50 text-destructive hover:bg-destructive/10' : 'border-border hover:bg-muted')}>{submitting === option.id ? 'Working...' : option.label}</button>)}
          </div>
          {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
        </div>
      </div>
    </section>
  )
}
