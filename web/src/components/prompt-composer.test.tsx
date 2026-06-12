import { render, screen } from '@testing-library/react'
import { PromptComposer } from '@/components/prompt-composer'

test('prompt composer disables submission while running', () => {
  render(
    <PromptComposer
      disabled
      disabledReason="This session is running."
      onSubmit={async () => undefined}
    />,
  )

  expect(screen.getByLabelText('Prompt')).toBeDisabled()
  expect(screen.getByLabelText('Submit prompt')).toBeDisabled()
})
