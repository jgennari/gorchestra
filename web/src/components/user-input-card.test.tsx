import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UserInputCard } from '@/components/user-input-card'
import type { PendingUserInputRequest } from '@/lib/events'

test('paged answers advance and submit on the final selection', async () => {
  const user = userEvent.setup()
  const onAnswer = vi.fn(async () => undefined)

  render(<UserInputCard request={request()} onAnswer={onAnswer} />)

  expect(screen.getByText('Pick a deployment')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: /Moon Launch/i }))

  expect(screen.getByText('Pick a scheduler')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: /Tiny Parade/i }))

  await waitFor(() => {
    expect(onAnswer).toHaveBeenCalledWith('call_test', {
      deployment: { answers: ['Moon Launch'] },
      scheduler: { answers: ['Tiny Parade'] },
    })
  })
})

test('typing spaces in the other-answer input does not advance the question', async () => {
  const user = userEvent.setup()
  const onAnswer = vi.fn(async () => undefined)

  render(<UserInputCard request={requestWithOther()} onAnswer={onAnswer} />)

  const otherInput = screen.getByLabelText('Other answer for Pick a deployment')
  await user.click(otherInput)
  await user.keyboard('custom answer with spaces')

  expect(screen.getByText('Pick a deployment')).toBeInTheDocument()
  expect(screen.queryByText('Pick a scheduler')).not.toBeInTheDocument()
  expect(otherInput).toHaveValue('custom answer with spaces')
  expect(onAnswer).not.toHaveBeenCalled()
})

function request(): PendingUserInputRequest {
  return {
    requestID: 'call_test',
    provider: 'codex',
    providerEventType: 'item/tool/requestUserInput',
    threadID: 'thread_test',
    turnID: 'turn_test',
    itemID: 'call_test',
    createdAt: '2026-06-14T12:00:00Z',
    seq: 10,
    questions: [
      {
        id: 'deployment',
        header: 'Test Choice',
        question: 'Pick a deployment',
        is_other: false,
        is_secret: false,
        options: [
          { label: 'Moon Launch', description: 'Lunar release pipeline.' },
          { label: 'Jazz Mode', description: 'Improvisational orchestration flow.' },
        ],
      },
      {
        id: 'scheduler',
        header: 'Test Choice',
        question: 'Pick a scheduler',
        is_other: false,
        is_secret: false,
        options: [
          { label: 'Tiny Parade', description: 'Miniature marching-band scheduler.' },
          { label: 'Night Train', description: 'Late release queue.' },
        ],
      },
    ],
  }
}

function requestWithOther(): PendingUserInputRequest {
  return {
    ...request(),
    questions: [
      {
        id: 'deployment',
        header: 'Test Choice',
        question: 'Pick a deployment',
        is_other: true,
        is_secret: false,
        options: [{ label: 'Moon Launch', description: 'Lunar release pipeline.' }],
      },
      ...request().questions.slice(1),
    ],
  }
}
