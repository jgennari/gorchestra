import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { SessionRenameForm, SessionTitle } from '@/components/session-title-editor'

test('rename form shows saving state while an update is pending', async () => {
  const user = userEvent.setup()
  const save = deferred<void>()

  function Harness() {
    const [title, setTitle] = useState('Old title')
    return (
      <SessionRenameForm
        title={title}
        onSave={async (nextTitle) => {
          await save.promise
          setTitle(nextTitle)
        }}
      />
    )
  }

  render(<Harness />)

  const input = screen.getByRole('textbox', { name: 'Session name' })
  await user.clear(input)
  await user.type(input, '  New title  ')
  await user.click(screen.getByRole('button', { name: 'Save session name' }))

  expect(input).toHaveValue('  New title  ')
  expect(screen.getByRole('button', { name: 'Save session name' })).toHaveTextContent('Saving')

  save.resolve()

  await waitFor(() => expect(screen.getByRole('button', { name: 'Save session name' })).toHaveTextContent('Save'))
  expect(input).toHaveValue('New title')
})

test('rename form submits with Enter and shows inline save errors', async () => {
  const user = userEvent.setup()
  const onSave = vi.fn(async () => {
    throw new Error('write failed')
  })

  render(<SessionRenameForm title="Old title" onSave={onSave} />)

  const input = screen.getByRole('textbox', { name: 'Session name' })
  await user.clear(input)
  await user.type(input, 'New title{Enter}')

  expect(onSave).toHaveBeenCalledWith('New title')
  expect(await screen.findByRole('alert')).toHaveTextContent('write failed')
  expect(input).toHaveValue('New title')
})

test('rename form allows clearing the session name', async () => {
  const user = userEvent.setup()
  const onSave = vi.fn(async () => undefined)
  render(<SessionRenameForm title="Old title" onSave={onSave} />)

  await user.clear(screen.getByRole('textbox', { name: 'Session name' }))
  await user.click(screen.getByRole('button', { name: 'Save session name' }))

  expect(onSave).toHaveBeenCalledWith('')
})

test('session title renders the empty-title fallback without an edit action', () => {
  render(<SessionTitle title="" />)

  expect(screen.getByRole('heading', { name: 'Untitled session' })).toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })

  return { promise, resolve, reject }
}
