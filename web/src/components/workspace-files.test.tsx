import { render, screen, waitFor } from '@testing-library/react'
import { WorkspaceFileContentView } from '@/components/workspace-files'
import type { WorkspaceFileContent } from '@/lib/api'

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}))

vi.mock('@monaco-editor/react', () => ({
  default: () => <textarea aria-label="File editor" />,
}))

vi.mock('mermaid', () => ({
  default: mermaidMocks,
}))

beforeEach(() => {
  mermaidMocks.initialize.mockReset()
  mermaidMocks.render.mockReset()
  mermaidMocks.render.mockImplementation((id: string) =>
    Promise.resolve({ svg: `<svg data-testid="rendered-mermaid" id="${id}"></svg>` }),
  )
})

test('renders Mermaid fences as diagrams with strict security', async () => {
  renderFile('# Architecture\n\n```mermaid\nflowchart LR\n  api --> db\n```\n\n```ts\nconst value = 1\n```')

  expect(screen.getByText('Rendering diagram')).toBeInTheDocument()
  expect(await screen.findByRole('img', { name: 'Mermaid diagram' })).toContainElement(
    screen.getByTestId('rendered-mermaid'),
  )
  expect(mermaidMocks.render).toHaveBeenCalledWith(expect.stringMatching(/^gorchestra-mermaid-\d+$/), 'flowchart LR\n  api --> db')
  expect(mermaidMocks.initialize).toHaveBeenCalledWith(
    expect.objectContaining({
      securityLevel: 'strict',
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: 'dark',
    }),
  )
  expect(screen.getByText('const value = 1')).toBeInTheDocument()
})

test('uses a unique Mermaid render ID for every diagram', async () => {
  renderFile('```mermaid\ngraph TD\n  a --> b\n```\n\n```mermaid\ngraph TD\n  c --> d\n```')

  await waitFor(() => expect(mermaidMocks.render).toHaveBeenCalledTimes(2))
  const firstID = mermaidMocks.render.mock.calls[0]?.[0]
  const secondID = mermaidMocks.render.mock.calls[1]?.[0]
  expect(firstID).not.toBe(secondID)
})

test('re-renders Mermaid diagrams when the application theme changes', async () => {
  const file = markdownFile('```mermaid\nsequenceDiagram\n  Client->>Server: Request\n```')
  const view = render(
    <WorkspaceFileContentView
      sessionID="session-1"
      file={file}
      resolvedTheme="dark"
      onFileSaved={() => undefined}
    />,
  )

  await waitFor(() => expect(mermaidMocks.render).toHaveBeenCalledTimes(1))
  expect(mermaidMocks.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }))

  view.rerender(
    <WorkspaceFileContentView
      sessionID="session-1"
      file={file}
      resolvedTheme="light"
      onFileSaved={() => undefined}
    />,
  )

  await waitFor(() => expect(mermaidMocks.render).toHaveBeenCalledTimes(2))
  expect(mermaidMocks.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'default' }))
})

test('keeps invalid Mermaid source readable', async () => {
  mermaidMocks.render.mockRejectedValueOnce(new Error('Parse error on line 2'))

  renderFile('# Broken diagram\n\n```mermaid\ngraph TD\n  a --\n```')

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Unable to render Mermaid diagram: Parse error on line 2')
  expect(alert.nextElementSibling).toHaveTextContent(/graph TD\s+a --/)
  expect(screen.getByRole('heading', { name: 'Broken diagram' })).toBeInTheDocument()
})

function renderFile(content: string) {
  return render(
    <WorkspaceFileContentView
      sessionID="session-1"
      file={markdownFile(content)}
      resolvedTheme="dark"
      onFileSaved={() => undefined}
    />,
  )
}

function markdownFile(content: string): WorkspaceFileContent {
  return {
    name: 'README.md',
    path: 'README.md',
    size_bytes: content.length,
    modified_at: '2026-08-12T00:00:00Z',
    content,
    encoding: 'utf-8',
    truncated: false,
  }
}
