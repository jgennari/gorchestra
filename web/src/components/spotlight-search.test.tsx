import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SpotlightSearch } from '@/components/spotlight-search'

const apiMocks = vi.hoisted(() => ({
  searchSpotlight: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  searchSpotlight: apiMocks.searchSpotlight,
}))

beforeEach(() => {
  apiMocks.searchSpotlight.mockReset()
})

test('searches globally and locally, labels result kinds, and selects with the keyboard', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  apiMocks.searchSpotlight.mockResolvedValue({
    query: 'deploy',
    results: [
      {
        id: 'tool:sess-1:12',
        kind: 'tool_call',
        scope: 'global',
        title: 'exec_command',
        snippet: 'deploy canary',
        session_id: 'sess-1',
        session_title: 'Release work',
        event_seq: 12,
      },
      {
        id: 'instruction:sess-1:AGENTS.md',
        kind: 'agent_instruction',
        scope: 'local',
        title: 'docs/AGENTS.md',
        snippet: 'Deployment instructions',
        session_id: 'sess-1',
        session_title: 'Release work',
        path: 'docs/AGENTS.md',
        line_number: 8,
      },
    ],
  })

  render(
    <SpotlightSearch open sessionID="sess-1" onOpenChange={() => undefined} onSelect={onSelect} />,
  )

  const input = screen.getByRole('textbox', { name: 'Search Gorchestra' })
  await user.type(input, 'deploy')
  expect(await screen.findByText('Tool call')).toBeInTheDocument()
  expect(screen.getByText('Agent instruction')).toBeInTheDocument()
  await waitFor(() => expect(apiMocks.searchSpotlight).toHaveBeenCalledWith('deploy', 'sess-1', expect.any(AbortSignal)))

  expect(screen.getByRole('button', { name: 'All 2' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: 'Tools 1' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Instructions 1' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Tools 1' }))
  expect(screen.getByRole('option', { name: /exec_command/ })).toBeInTheDocument()
  expect(screen.queryByRole('option', { name: /docs\/AGENTS.md/ })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'All 2' }))

  await user.keyboard('{ArrowDown}{Enter}')
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agent_instruction', line_number: 8 }))
})

test('stays compact before a query and reports empty results after search', async () => {
  const user = userEvent.setup()
  apiMocks.searchSpotlight.mockResolvedValue({ query: 'missing', results: [] })
  render(<SpotlightSearch open sessionID={null} onOpenChange={() => undefined} onSelect={() => undefined} />)

  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  await user.type(screen.getByRole('textbox', { name: 'Search Gorchestra' }), 'missing')
  expect(await screen.findByText('No results for “missing”')).toBeInTheDocument()
  expect(screen.getByRole('listbox')).toBeInTheDocument()
})
