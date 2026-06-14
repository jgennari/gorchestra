import { afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PromptComposer } from '@/components/prompt-composer'

afterEach(() => {
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

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

test('codex toolbar submits selected options with the prompt', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn(async () => undefined)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe('/api/agents/codex/options')
      return jsonResponse({
        default_model: 'gpt-5.5',
        models: [
          {
            id: 'gpt-5.5',
            model: 'gpt-5.5',
            display_name: 'GPT-5.5',
            description: 'Default Codex model',
            hidden: false,
            supported_reasoning_efforts: [
              { reasoning_effort: 'medium', description: 'Medium' },
              { reasoning_effort: 'xhigh', description: 'Extra high' },
            ],
            default_reasoning_effort: 'medium',
            service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }],
            default_service_tier: '',
            is_default: true,
          },
        ],
        collaboration_modes: [
          { name: 'Plan', mode: 'plan', reasoning_effort: 'medium' },
          { name: 'Default', mode: 'default' },
        ],
      })
    }),
  )

  render(
    <PromptComposer
      agentType="codex"
      disabled={false}
      disabledReason=""
      onSubmit={onSubmit}
    />,
  )

  expect(screen.getByText('Loading Codex options...')).toBeInTheDocument()
  expect(await screen.findByRole('button', { name: 'Model' })).toHaveTextContent('GPT-5.5')
  expect(screen.getByRole('button', { name: 'Reasoning' })).toHaveTextContent('medium')

  await user.click(screen.getByRole('button', { name: 'Fast' }))
  await user.click(screen.getByRole('button', { name: 'Plan' }))

  expect(screen.getByLabelText('Prompt').closest('.codex-plan-composer')).toBeInTheDocument()

  await user.type(screen.getByLabelText('Prompt'), 'Hello Codex{enter}')

  await waitFor(() => {
    expect(onSubmit).toHaveBeenCalledWith('Hello Codex', {
      codex: {
        model: 'gpt-5.5',
        reasoning_effort: 'medium',
        fast_mode: true,
        planning_mode: true,
        service_tier: 'priority',
      },
    })
  })
})

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
