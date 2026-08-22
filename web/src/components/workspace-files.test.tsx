import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

test('previews images and exposes open and download actions', () => {
  renderWorkspaceFile(
    binaryFile({
      name: 'image one.png',
      path: 'assets/image one.png',
      media_type: 'image/png',
      preview_kind: 'image',
    }),
  )

  expect(screen.getByRole('img', { name: 'image one.png' })).toHaveAttribute(
    'src',
    '/api/sessions/session-1/files/raw?path=assets%2Fimage+one.png',
  )
  expect(screen.getByRole('link', { name: 'Open image one.png in new tab' })).toHaveAttribute('target', '_blank')
  expect(screen.getByRole('link', { name: 'Download image one.png' })).toHaveAttribute(
    'href',
    '/api/sessions/session-1/files/raw?path=assets%2Fimage+one.png&download=1',
  )
  expect(screen.getByRole('link', { name: 'Download image one.png' })).toHaveAttribute('download', 'image one.png')
})

test.each([
  ['audio', 'clip.mp3'],
  ['video', 'clip.mp4'],
  ['pdf', 'notes.pdf'],
] as const)('renders the browser-native %s viewer', (previewKind, name) => {
  renderWorkspaceFile(binaryFile({ name, path: name, media_type: mediaTypeFor(previewKind), preview_kind: previewKind }))

  expect(screen.getByLabelText(`Preview ${name}`)).toHaveAttribute(
    'src',
    `/api/sessions/session-1/files/raw?path=${encodeURIComponent(name)}`,
  )
})

test('shows a browser fallback when an image cannot be decoded', () => {
  renderWorkspaceFile(binaryFile({ name: 'photo.heic', path: 'photo.heic', media_type: 'image/heic', preview_kind: 'image' }))

  fireEvent.error(screen.getByRole('img', { name: 'photo.heic' }))

  expect(screen.getByRole('status')).toHaveTextContent('Preview unavailable in this browser')
  expect(screen.getByRole('link', { name: 'Open photo.heic in new tab' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Download photo.heic' })).toBeInTheDocument()
})

test('offers downloads without inline actions for unsupported binary and text files', () => {
  const view = renderWorkspaceFile(binaryFile({ preview_kind: 'none' }))

  expect(screen.getByText('No inline preview is available for this file type.')).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: /open .* in new tab/i })).not.toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Download archive.bin' })).toBeInTheDocument()

  view.rerender(
    <WorkspaceFileContentView
      sessionID="session-1"
      file={markdownFile('# Notes')}
      resolvedTheme="dark"
      onFileSaved={() => undefined}
    />,
  )
  expect(screen.getByRole('link', { name: 'Download README.md' })).toBeInTheDocument()
})

function renderFile(content: string) {
  return renderWorkspaceFile(markdownFile(content))
}

function renderWorkspaceFile(file: WorkspaceFileContent) {
  return render(
    <WorkspaceFileContentView
      sessionID="session-1"
      file={file}
      resolvedTheme="dark"
      onFileSaved={() => undefined}
    />,
  )
}

function binaryFile(overrides: Partial<WorkspaceFileContent> = {}): WorkspaceFileContent {
  return {
    name: 'archive.bin',
    path: 'archive.bin',
    size_bytes: 2048,
    modified_at: '2026-08-12T00:00:00Z',
    content: '',
    encoding: 'binary',
    media_type: 'application/octet-stream',
    preview_kind: 'none',
    truncated: false,
    ...overrides,
  }
}

function mediaTypeFor(previewKind: 'audio' | 'video' | 'pdf') {
  if (previewKind === 'audio') return 'audio/mpeg'
  if (previewKind === 'video') return 'video/mp4'
  return 'application/pdf'
}

function markdownFile(content: string): WorkspaceFileContent {
  return {
    name: 'README.md',
    path: 'README.md',
    size_bytes: content.length,
    modified_at: '2026-08-12T00:00:00Z',
    content,
    encoding: 'utf-8',
    media_type: 'text/markdown',
    preview_kind: 'none',
    truncated: false,
  }
}
