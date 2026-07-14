import type { PermissionPolicy } from '@/lib/api'
import { cn } from '@/lib/utils'

const policies: Array<{ value: PermissionPolicy; label: string }> = [
  { value: 'ask', label: 'Ask' }, { value: 'deny', label: 'Deny' }, { value: 'bypass', label: 'Bypass' },
]

export function PermissionPolicyControl({ value, disabled, onChange }: { value: PermissionPolicy; disabled?: boolean; onChange: (value: PermissionPolicy) => void }) {
  return <div role="radiogroup" aria-label="Permission policy" className="grid grid-cols-3 overflow-hidden rounded-md border border-border/80">
    {policies.map((policy) => <button key={policy.value} type="button" role="radio" aria-checked={value === policy.value} disabled={disabled} onClick={() => onChange(policy.value)} className={cn('min-h-9 border-r border-border/80 px-2 text-xs font-medium last:border-r-0 disabled:opacity-50', value === policy.value ? policy.value === 'bypass' ? 'bg-destructive/12 text-destructive' : 'bg-primary/12 text-foreground' : 'text-muted-foreground hover:bg-muted')}>{policy.label}</button>)}
  </div>
}
