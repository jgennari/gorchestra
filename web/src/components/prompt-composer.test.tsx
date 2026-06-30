import { afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PromptComposer } from '@/components/prompt-composer'

afterEach(() => {
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

test('enter submits the prompt and clears the input', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn(async () => undefined)

  render(<PromptComposer disabled={false} disabledReason="" onSubmit={onSubmit} />)

  const prompt = screen.getByLabelText('Prompt')
  expect(prompt).toHaveAttribute('rows', '1')

  await user.type(prompt, 'Hello agent{enter}')

  expect(onSubmit).toHaveBeenCalledWith('Hello agent')
  expect(prompt).toHaveValue('')
  await waitFor(() => expect(prompt).toHaveFocus())
})

test('submit errors are reported to the parent instead of rendering under the composer', async () => {
  const user = userEvent.setup()
  const onError = vi.fn()

  render(
    <PromptComposer
      disabled={false}
      disabledReason=""
      onSubmit={async () => {
        throw new Error('HTTP 502')
      }}
      onError={onError}
    />,
  )

  await user.type(screen.getByLabelText('Prompt'), 'Hello agent{enter}')

  await waitFor(() => expect(onError).toHaveBeenCalledWith('HTTP 502'))
  expect(screen.queryByText('HTTP 502')).not.toBeInTheDocument()
})

test('shift enter inserts a newline without submitting', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn(async () => undefined)

  render(<PromptComposer disabled={false} disabledReason="" onSubmit={onSubmit} />)

  const prompt = screen.getByLabelText('Prompt')
  await user.type(prompt, 'Line one')
  await user.keyboard('{Shift>}{Enter}{/Shift}')
  await user.type(prompt, 'Line two')

  expect(onSubmit).not.toHaveBeenCalled()
  expect(prompt).toHaveValue('Line one\nLine two')
})

test('cmd or ctrl shift enter queues the draft on the server', async () => {
  const user = userEvent.setup()
  const queued = [] as ReturnType<typeof queuedMessage>[]
  vi.stubGlobal('fetch', queueFetchMock(queued))
  const onSubmit = vi.fn(async (content: string) => {
    queued.push(queuedMessage(`queue_${queued.length + 1}`, content, queued.length + 1))
  })

  render(<PromptComposer sessionID="sess_1" disabled={false} disabledReason="" onSubmit={onSubmit} />)

  const prompt = screen.getByLabelText('Prompt')
  await user.type(prompt, 'Queued prompt')
  await user.keyboard('{Meta>}{Shift>}{Enter}{/Shift}{/Meta}')

  expect(onSubmit).toHaveBeenCalledWith('Queued prompt', undefined, undefined, true)
  expect(prompt).toHaveValue('')
  expect(await screen.findByText('Queued prompt')).toBeInTheDocument()
  await waitFor(() => expect(prompt).toHaveFocus())
})

test('queue button enqueues up to five server drafts and allows removal', async () => {
  const user = userEvent.setup()
  const queued = [] as ReturnType<typeof queuedMessage>[]
  vi.stubGlobal('fetch', queueFetchMock(queued))
  const onSubmit = vi.fn(async (content: string) => {
    queued.push(queuedMessage(`queue_${queued.length + 1}`, content, queued.length + 1))
  })

  render(<PromptComposer sessionID="sess_1" disabled={false} disabledReason="" onSubmit={onSubmit} />)

  const prompt = screen.getByLabelText('Prompt')
  for (let index = 1; index <= 5; index += 1) {
    await user.type(prompt, `Queued ${index}`)
    await user.click(screen.getByRole('button', { name: /queue message/i }))
    await waitFor(() => expect(prompt).toHaveFocus())
  }

  expect(screen.getAllByRole('button', { name: /remove queued message/i })).toHaveLength(5)
  expect(screen.getByText('Queued 5')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /queue message/i })).toBeDisabled()

  await user.click(screen.getByRole('button', { name: 'Remove queued message 3' }))

  await waitFor(() => expect(screen.queryByText('Queued 3')).not.toBeInTheDocument())
  expect(screen.getAllByRole('button', { name: /remove queued message/i })).toHaveLength(4)
})

test('attaches image files with previews, removal, and submit payloads', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn(async () => undefined)
  const firstImage = new File(['first'], 'first.png', { type: 'image/png' })
  const secondImage = new File(['second'], 'second.jpg', { type: 'image/jpeg' })

  render(<PromptComposer disabled={false} disabledReason="" onSubmit={onSubmit} />)

  await user.upload(screen.getByLabelText('Image attachments'), firstImage)
  expect(await screen.findByAltText('first.png')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Remove first.png' }))
  expect(screen.queryByAltText('first.png')).not.toBeInTheDocument()

  fireEvent.dragOver(screen.getByTestId('prompt-composer-dropzone'), {
    dataTransfer: { types: ['Files'] },
  })
  fireEvent.drop(screen.getByTestId('prompt-composer-dropzone'), {
    dataTransfer: { types: ['Files'], files: [secondImage] },
  })
  expect(await screen.findByAltText('second.jpg')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Submit prompt' }))

  await waitFor(() => {
    expect(onSubmit).toHaveBeenCalledWith('', undefined, [
      expect.objectContaining({
        name: 'second.jpg',
        media_type: 'image/jpeg',
        size_bytes: secondImage.size,
      }),
    ])
  })
  expect(screen.queryByAltText('second.jpg')).not.toBeInTheDocument()
})

test('pastes image clipboard items into attachments', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn(async () => undefined)
  const pastedImage = new File(['pasted'], 'pasted.png', { type: 'image/png' })

  render(<PromptComposer disabled={false} disabledReason="" onSubmit={onSubmit} />)

  fireEvent.paste(screen.getByLabelText('Prompt'), {
    clipboardData: {
      files: [],
      items: [
        {
          kind: 'file',
          type: 'image/png',
          getAsFile: () => pastedImage,
        },
      ],
    },
  })

  expect(await screen.findByAltText('pasted.png')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Submit prompt' }))

  await waitFor(() => {
    expect(onSubmit).toHaveBeenCalledWith('', undefined, [
      expect.objectContaining({
        name: 'pasted.png',
        media_type: 'image/png',
        size_bytes: pastedImage.size,
      }),
    ])
  })
})

test('prompt composer queues enter submissions while running', async () => {
  const user = userEvent.setup()
  const queued = [] as ReturnType<typeof queuedMessage>[]
  vi.stubGlobal('fetch', queueFetchMock(queued))
  const onSubmit = vi.fn(async (content: string) => {
    queued.push(queuedMessage(`queue_${queued.length + 1}`, content, queued.length + 1))
  })
  const onCancel = vi.fn(async () => undefined)

  render(
    <PromptComposer
      disabled
      disabledReason="This session is running."
      sessionID="sess_1"
      sessionStatus="running"
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
  )

  const prompt = screen.getByLabelText('Prompt')
  expect(prompt).toBeEnabled()
  expect(screen.queryByLabelText('Submit prompt')).not.toBeInTheDocument()

  await user.type(prompt, 'Draft next message{enter}')

  expect(onSubmit).toHaveBeenCalledWith('Draft next message', undefined, undefined, true)
  expect(prompt).toHaveValue('')
  expect(await screen.findByText('Draft next message')).toBeInTheDocument()
  await waitFor(() => expect(prompt).toHaveFocus())

  await user.click(screen.getByRole('button', { name: 'Cancel running session' }))

  expect(onCancel).toHaveBeenCalledOnce()
})

test('queue shortcut reports an error when attachments are present', async () => {
  const user = userEvent.setup()
  const onError = vi.fn()
  const image = new File(['first'], 'first.png', { type: 'image/png' })

  render(<PromptComposer disabled={false} disabledReason="" onSubmit={async () => undefined} onError={onError} />)

  await user.upload(screen.getByLabelText('Image attachments'), image)
  await user.type(screen.getByLabelText('Prompt'), 'Queued prompt')
  await user.keyboard('{Control>}{Shift>}{Enter}{/Shift}{/Control}')

  expect(onError).toHaveBeenCalledWith('Queued messages cannot include image attachments.')
  expect(screen.getByLabelText('Prompt')).toHaveValue('Queued prompt')
})

test('debug toggle uses orange active styling', async () => {
  const user = userEvent.setup()
  const onShowDebugEventsChange = vi.fn()

  render(
    <PromptComposer
      disabled={false}
      disabledReason=""
      showDebugEvents
      onShowDebugEventsChange={onShowDebugEventsChange}
      onSubmit={async () => undefined}
    />,
  )

  const debug = screen.getByRole('button', { name: 'Debug' })
  expect(debug).toHaveClass('bg-orange-100')
  expect(debug).not.toHaveTextContent('Debug')

  await user.click(debug)

  expect(onShowDebugEventsChange).toHaveBeenCalledWith(false)
})

test('codex composer exposes compact mobile options and hides debug on mobile', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(codexOptionsResponse())),
  )

  render(
    <PromptComposer
      agentType="codex"
      disabled={false}
      disabledReason=""
      showDebugEvents
      onShowDebugEventsChange={() => undefined}
      onSubmit={async () => undefined}
    />,
  )

  expect(await screen.findByRole('button', { name: 'Model' })).toHaveTextContent('GPT-5.5')

  const debug = screen.getByRole('button', { name: 'Debug' })
  expect(debug.parentElement).toHaveClass('hidden')
  expect(debug.parentElement).toHaveClass('sm:inline-flex')

  const optionsButton = screen.getByRole('button', { name: 'Composer options', hidden: true })
  expect(optionsButton.parentElement).toHaveClass('sm:hidden')

  fireEvent.click(optionsButton)

  const dialog = screen.getByRole('dialog', { name: 'Composer options', hidden: true })
  expect(within(dialog).getByRole('button', { name: 'Model', hidden: true })).toHaveTextContent('GPT-5.5')
  expect(within(dialog).getByRole('button', { name: 'Reasoning', hidden: true })).toHaveTextContent('medium')
})

test('draft messages persist per session', async () => {
  const user = userEvent.setup()
  vi.stubGlobal('fetch', queueFetchMock([]))

  const first = render(
    <PromptComposer sessionID="sess_1" disabled={false} disabledReason="" onSubmit={async () => undefined} />,
  )
  await user.type(screen.getByLabelText('Prompt'), 'First draft')
  await waitFor(() => {
    expect(window.localStorage.getItem('gorchestra.session-composer.sess_1')).toContain('First draft')
  })
  first.unmount()

  const second = render(
    <PromptComposer sessionID="sess_2" disabled={false} disabledReason="" onSubmit={async () => undefined} />,
  )
  expect(screen.getByLabelText('Prompt')).toHaveValue('')
  await user.type(screen.getByLabelText('Prompt'), 'Second draft')
  second.unmount()

  render(<PromptComposer sessionID="sess_1" disabled={false} disabledReason="" onSubmit={async () => undefined} />)

  expect(screen.getByLabelText('Prompt')).toHaveValue('First draft')
})

test('refreshes server queued messages after queue lifecycle events', async () => {
  const queued = [] as ReturnType<typeof queuedMessage>[]
  vi.stubGlobal('fetch', queueFetchMock(queued))
  const { rerender } = render(
    <PromptComposer
      sessionID="sess_1"
      disabled={false}
      disabledReason=""
      onSubmit={async () => undefined}
    />,
  )

  expect(screen.queryByText('Queued follow-up')).not.toBeInTheDocument()
  queued.push(queuedMessage('queue_1', 'Queued follow-up', 1))

  rerender(
    <PromptComposer
      sessionID="sess_1"
      disabled={false}
      disabledReason=""
      sessionStatus="idle"
      latestQueueEvent={{
        id: 'evt_9',
        session_id: 'sess_1',
        seq: 9,
        type: 'user.message.queued',
        role: 'user',
        status: 'completed',
        payload: {},
        created_at: '2026-06-12T16:00:00Z',
      }}
      onSubmit={async () => undefined}
    />,
  )

  expect(await screen.findByText('Queued follow-up')).toBeInTheDocument()
})

test('does not auto-submit server queued messages after failed or completed runs', async () => {
  const onSubmit = vi.fn(async () => undefined)
  vi.stubGlobal('fetch', queueFetchMock([queuedMessage('queue_1', 'Queued follow-up')]))
  const terminalBase = {
    id: 'evt_10',
    session_id: 'sess_1',
    role: 'assistant' as const,
    payload: {},
    created_at: '2026-06-12T16:00:00Z',
  }

  const { rerender } = render(
    <PromptComposer
      sessionID="sess_1"
      disabled
      disabledReason="This session is running."
      sessionStatus="running"
      onSubmit={onSubmit}
    />,
  )

  rerender(
    <PromptComposer
      sessionID="sess_1"
      disabled={false}
      disabledReason=""
      sessionStatus="failed"
      latestTerminalEvent={{ ...terminalBase, seq: 10, type: 'agent.run.failed', status: 'failed' }}
      onSubmit={onSubmit}
    />,
  )

  await waitFor(() => expect(onSubmit).not.toHaveBeenCalled())

  rerender(
    <PromptComposer
      sessionID="sess_1"
      disabled
      disabledReason="This session is running."
      sessionStatus="running"
      onSubmit={onSubmit}
    />,
  )

  rerender(
    <PromptComposer
      sessionID="sess_1"
      disabled={false}
      disabledReason=""
      sessionStatus="idle"
      hasPendingUserInput
      latestTerminalEvent={{ ...terminalBase, seq: 11, type: 'agent.run.completed', status: 'completed' }}
      onSubmit={onSubmit}
    />,
  )

  await waitFor(() => expect(onSubmit).not.toHaveBeenCalled())
  expect(await screen.findByText('Queued follow-up')).toBeInTheDocument()
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

  render(<PromptComposer agentType="codex" disabled={false} disabledReason="" onSubmit={onSubmit} />)

  expect(screen.getByText('Loading Codex options...')).toBeInTheDocument()
  expect(await screen.findByRole('button', { name: 'Model' })).toHaveTextContent('GPT-5.5')
  expect(screen.getByRole('button', { name: 'Reasoning' })).toHaveTextContent('medium')

  await user.click(screen.getByRole('button', { name: 'Fast' }))
  await user.click(screen.getByRole('switch', { name: 'Plan' }))

  expect(screen.getByRole('switch', { name: 'Plan' })).toHaveAttribute('aria-checked', 'true')
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

test('claude toolbar submits selected options with the prompt', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn(async () => undefined)

  render(<PromptComposer agentType="claude" disabled={false} disabledReason="" onSubmit={onSubmit} />)

  await user.click(screen.getByRole('button', { name: 'Model' }))
  await user.click(screen.getByRole('option', { name: 'Opus' }))
  await user.click(screen.getByRole('button', { name: 'Effort' }))
  await user.click(screen.getByRole('option', { name: 'high' }))
  await user.click(screen.getByRole('switch', { name: 'Plan' }))

  expect(screen.getByLabelText('Prompt').closest('.codex-plan-composer')).toBeInTheDocument()

  await user.type(screen.getByLabelText('Prompt'), 'Hello Claude{enter}')

  await waitFor(() => {
    expect(onSubmit).toHaveBeenCalledWith('Hello Claude', {
      claude: {
        model: 'opus',
        effort: 'high',
        planning_mode: true,
      },
    })
  })
})

test('codex toolbar settings persist per session', async () => {
  const user = userEvent.setup()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(codexOptionsResponse())),
  )

  const first = render(
    <PromptComposer
      sessionID="sess_codex_1"
      agentType="codex"
      disabled={false}
      disabledReason=""
      onSubmit={async () => undefined}
    />,
  )
  expect(await screen.findByRole('button', { name: 'Model' })).toHaveTextContent('GPT-5.5')

  await user.click(screen.getByRole('button', { name: 'Model' }))
  await user.click(screen.getByRole('option', { name: /GPT-5 Mini/ }))
  await user.click(screen.getByRole('button', { name: 'Reasoning' }))
  await user.click(screen.getByRole('option', { name: /xhigh/ }))
  await user.click(screen.getByRole('button', { name: 'Fast' }))
  await user.click(screen.getByRole('switch', { name: 'Plan' }))

  expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('GPT-5 Mini')
  expect(screen.getByRole('button', { name: 'Reasoning' })).toHaveTextContent('xhigh')
  expect(screen.getByRole('button', { name: 'Fast' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('switch', { name: 'Plan' })).toHaveAttribute('aria-checked', 'true')
  first.unmount()

  const second = render(
    <PromptComposer
      sessionID="sess_codex_2"
      agentType="codex"
      disabled={false}
      disabledReason=""
      onSubmit={async () => undefined}
    />,
  )
  expect(await screen.findByRole('button', { name: 'Model' })).toHaveTextContent('GPT-5.5')
  expect(screen.getByRole('button', { name: 'Reasoning' })).toHaveTextContent('medium')
  expect(screen.getByRole('button', { name: 'Fast' })).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByRole('switch', { name: 'Plan' })).toHaveAttribute('aria-checked', 'false')
  second.unmount()

  render(
    <PromptComposer
      sessionID="sess_codex_1"
      agentType="codex"
      disabled={false}
      disabledReason=""
      onSubmit={async () => undefined}
    />,
  )
  expect(await screen.findByRole('button', { name: 'Model' })).toHaveTextContent('GPT-5 Mini')
  expect(screen.getByRole('button', { name: 'Reasoning' })).toHaveTextContent('xhigh')
  expect(screen.getByRole('button', { name: 'Fast' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('switch', { name: 'Plan' })).toHaveAttribute('aria-checked', 'true')
})

test('codex model and reasoning menus are mutually exclusive', async () => {
  const user = userEvent.setup()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(codexOptionsResponse())),
  )

  render(
    <PromptComposer
      sessionID="sess_codex"
      agentType="codex"
      disabled={false}
      disabledReason=""
      onSubmit={async () => undefined}
    />,
  )

  await user.click(await screen.findByRole('button', { name: 'Model' }))
  expect(screen.getByRole('listbox', { name: 'Model' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Reasoning' }))

  expect(screen.queryByRole('listbox', { name: 'Model' })).not.toBeInTheDocument()
  expect(screen.getByRole('listbox', { name: 'Reasoning' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Model' }))

  expect(screen.getByRole('listbox', { name: 'Model' })).toBeInTheDocument()
  expect(screen.queryByRole('listbox', { name: 'Reasoning' })).not.toBeInTheDocument()
})

function codexOptionsResponse() {
  return {
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
      {
        id: 'gpt-5-mini',
        model: 'gpt-5-mini',
        display_name: 'GPT-5 Mini',
        description: 'Small Codex model',
        hidden: false,
        supported_reasoning_efforts: [
          { reasoning_effort: 'medium', description: 'Medium' },
          { reasoning_effort: 'xhigh', description: 'Extra high' },
        ],
        default_reasoning_effort: 'medium',
        service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }],
        default_service_tier: '',
        is_default: false,
      },
    ],
    collaboration_modes: [
      { name: 'Plan', mode: 'plan', reasoning_effort: 'medium' },
      { name: 'Default', mode: 'default' },
    ],
  }
}

function queuedMessage(id: string, content: string, seq = 1) {
  return {
    id,
    session_id: 'sess_1',
    seq,
    content,
    agent_options: {},
    created_at: '2026-06-12T16:00:00Z',
  }
}

function queueFetchMock(queued: ReturnType<typeof queuedMessage>[]) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url)
    if (path === '/api/sessions/sess_1/queued-messages') {
      return jsonResponse({ messages: queued })
    }
    if (path.startsWith('/api/sessions/sess_1/queued-messages/') && init?.method === 'DELETE') {
      const id = decodeURIComponent(path.slice('/api/sessions/sess_1/queued-messages/'.length))
      const index = queued.findIndex((message) => message.id === id)
      const removed = index >= 0 ? queued.splice(index, 1)[0] : queuedMessage(id, '')
      return jsonResponse(removed)
    }
    throw new Error(`unexpected URL ${path}`)
  })
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
