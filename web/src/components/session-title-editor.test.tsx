import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { SessionTitleEditor } from '@/components/session-title-editor'

test('title editor shows optimistic title while save is pending', async () => {
  const user = userEvent.setup()
  const save = deferred<void>()

  function Harness() {
    const [title, setTitle] = useState('Old title')
    return (
      <SessionTitleEditor
        title={title}
        onSave={async (nextTitle) => {
          await save.promise
          setTitle(nextTitle)
        }}
      />
    )
  }

  render(<Harness />)

  await user.click(screen.getByRole('button', { name: /edit session title/i }))
  const input = screen.getByRole('textbox', { name: 'Session title' })
  await user.clear(input)
  await user.type(input, 'New title')
  await user.click(screen.getByRole('button', { name: /save session title/i }))

  expect(screen.getByRole('heading', { name: 'New title' })).toBeInTheDocument()
  expect(screen.getByText('Saving')).toBeInTheDocument()

  save.resolve()

  await waitFor(() => expect(screen.queryByText('Saving')).not.toBeInTheDocument())
  expect(screen.getByRole('heading', { name: 'New title' })).toBeInTheDocument()
})

test('title editor reverts and shows inline error when save fails', async () => {
  const user = userEvent.setup()
  const onSave = vi.fn(async () => {
    throw new Error('write failed')
  })

  render(<SessionTitleEditor title="Old title" onSave={onSave} />)

  await user.click(screen.getByRole('button', { name: /edit session title/i }))
  const input = screen.getByRole('textbox', { name: 'Session title' })
  await user.clear(input)
  await user.type(input, 'New title')
  await user.click(screen.getByRole('button', { name: /save session title/i }))

  expect(await screen.findByRole('alert')).toHaveTextContent('write failed')
  expect(screen.getByRole('textbox', { name: 'Session title' })).toHaveValue('New title')
  expect(screen.queryByRole('heading', { name: 'New title' })).not.toBeInTheDocument()
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
