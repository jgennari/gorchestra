import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PermissionQueue } from '@/components/permission-queue'

test('permission queue renders structured detail and submits the stable option id', async () => {
  const user = userEvent.setup()
  const onResolve = vi.fn(async () => undefined)
  render(<PermissionQueue requests={[{ request_id:'perm_1', provider:'codex', provider_event_type:'item/commandExecution/requestApproval', kind:'command', title:'Approve command', command:'git push origin main', cwd:'/repo', options:[{ id:'acceptForSession', label:'Allow for session', decision:'allow', scope:'session' }], createdAt:'2026-07-14T12:00:00Z', seq:2 }]} onResolve={onResolve} />)
  expect(screen.getByText('git push origin main')).toBeInTheDocument()
  expect(screen.getByText('/repo')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name:'Allow for session' }))
  expect(onResolve).toHaveBeenCalledWith('perm_1', 'acceptForSession')
  expect(screen.queryByRole('group', { name: 'Permission required' })).not.toBeInTheDocument()
})

test('permission queue recovers when resolution fails', async () => {
  const user = userEvent.setup()
  const onResolve = vi.fn(async () => { throw new Error('The permission response timed out. Try again or stop the run.') })
  render(<PermissionQueue requests={[{ request_id:'perm_1', provider:'codex', provider_event_type:'item/commandExecution/requestApproval', kind:'command', title:'Approve command', command:'git push origin main', cwd:'/repo', options:[{ id:'accept', label:'Allow once', decision:'allow', scope:'once' }], createdAt:'2026-07-14T12:00:00Z', seq:2 }]} onResolve={onResolve} />)

  await user.click(screen.getByRole('button', { name:'Allow once' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('permission response timed out')
  expect(screen.getByRole('button', { name:'Allow once' })).toBeEnabled()
})
