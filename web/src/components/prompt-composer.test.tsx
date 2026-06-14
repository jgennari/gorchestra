import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PromptComposer } from '@/components/prompt-composer'

test('enter submits the prompt and clears the input', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn(async () => undefined)

  render(
    <PromptComposer
      disabled={false}
      disabledReason=""
      onSubmit={onSubmit}
    />,
  )

  const prompt = screen.getByLabelText('Prompt')
  expect(prompt).toHaveAttribute('rows', '1')

  await user.type(prompt, 'Hello agent{enter}')

  expect(onSubmit).toHaveBeenCalledWith('Hello agent')
  expect(prompt).toHaveValue('')
})

test('ctrl enter inserts a newline without submitting', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn(async () => undefined)

  render(
    <PromptComposer
      disabled={false}
      disabledReason=""
      onSubmit={onSubmit}
    />,
  )

  const prompt = screen.getByLabelText('Prompt')
  await user.type(prompt, 'Line one')
  await user.keyboard('{Control>}{Enter}{/Control}')
  await user.type(prompt, 'Line two')

  expect(onSubmit).not.toHaveBeenCalled()
  expect(prompt).toHaveValue('Line one\nLine two')
})

test('prompt composer shows cancellation action while running', async () => {
  const user = userEvent.setup()
  const onCancel = vi.fn(async () => undefined)

  render(
    <PromptComposer
      disabled
      disabledReason="This session is running."
      onSubmit={async () => undefined}
      onCancel={onCancel}
    />,
  )

  expect(screen.getByLabelText('Prompt')).toBeDisabled()
  expect(screen.queryByLabelText('Submit prompt')).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Cancel running session' }))

  expect(onCancel).toHaveBeenCalledOnce()
})
