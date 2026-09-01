import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { RepositorySkills } from '@/components/repository-skills'
import { createRepositorySkill, createUserSkill, listRepositorySkills, listUserSkills, repairRepositorySkillClaudeBridge } from '@/lib/api'

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    listRepositorySkills: vi.fn(),
    getRepositorySkill: vi.fn(),
    createRepositorySkill: vi.fn(),
    updateRepositorySkill: vi.fn(),
    deleteRepositorySkill: vi.fn(),
    repairRepositorySkillClaudeBridge: vi.fn(),
    repairRepositorySkillClaudeBridges: vi.fn(),
    listUserSkills: vi.fn(),
    getUserSkill: vi.fn(),
    createUserSkill: vi.fn(),
    updateUserSkill: vi.fn(),
    deleteUserSkill: vi.fn(),
    repairUserSkillClaudeBridge: vi.fn(),
    repairUserSkillClaudeBridges: vi.fn(),
  }
})

const session = {
  id: 'sess_1', title: 'Skills session', agent_type: 'codex' as const, status: 'idle' as const,
  workspace_path: '/repo', event_count: 0, tool_count: 0, created_at: '2026-09-01T12:00:00Z',
  updated_at: '2026-09-01T12:00:00Z', completed_at: null, archived_at: null,
}

beforeEach(() => {
  window.localStorage.clear()
  vi.mocked(listRepositorySkills).mockResolvedValue([])
  vi.mocked(listUserSkills).mockResolvedValue({ home_path: '/Users/tester', skills: [] })
  vi.mocked(createRepositorySkill).mockResolvedValue({
    directory_name: 'review-code', name: 'review-code', description: 'Review code changes',
    path: '.agents/skills/review-code/SKILL.md', modified_at: '2026-09-01T12:00:00Z', revision: 'rev_1',
    validation_errors: [], resource_count: 0, editable: true, linked: false,
    instructions: '# Review', claude_bridge: { status: 'linked', path: '.claude/skills/review-code' },
  })
})

test('manages service-user skills without a session', async () => {
  vi.mocked(createUserSkill).mockResolvedValue({
    directory_name: 'personal-review', name: 'personal-review', description: 'Review my projects',
    path: '.agents/skills/personal-review/SKILL.md', revision: 'rev_user', validation_errors: [],
    resource_count: 0, editable: true, linked: false,
    claude_bridge: { status: 'linked', path: '.claude/skills/personal-review' },
  })
  const user = userEvent.setup()
  render(<RepositorySkills userScope onOpenSessions={vi.fn()} />)
  expect(await screen.findByText('/Users/tester/.agents/skills')).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'User skills' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'New skill' }))
  await user.type(screen.getByLabelText('Name'), 'personal-review')
  await user.type(screen.getByLabelText('Description'), 'Review my projects')
  await user.click(screen.getByRole('button', { name: 'Save skill' }))
  await waitFor(() => expect(createUserSkill).toHaveBeenCalledWith(expect.objectContaining({
    name: 'personal-review', description: 'Review my projects',
  })))
})

const conflictingSkill = {
  directory_name: 'review-code', name: 'review-code', description: 'Review code changes',
  path: '.agents/skills/review-code/SKILL.md', modified_at: '2026-09-01T12:00:00Z', revision: 'rev_1',
  validation_errors: [], resource_count: 0, editable: true, linked: false,
  claude_bridge: { status: 'conflict' as const, path: '.claude/skills/review-code', message: 'an existing non-symlink entry is in the way' },
}

test('creates a repository skill with the guided editor', async () => {
  const user = userEvent.setup()
  render(<RepositorySkills session={session} onOpenFile={vi.fn()} />)

  await screen.findByText('No repository skills')
  await user.click(screen.getByRole('button', { name: 'New skill' }))
  await user.type(screen.getByLabelText('Name'), 'review-code')
  await user.type(screen.getByLabelText('Description'), 'Review code changes')
  await user.clear(screen.getByLabelText('Instructions (Markdown)'))
  await user.type(screen.getByLabelText('Instructions (Markdown)'), '# Review')
  await user.click(screen.getByRole('button', { name: 'Save skill' }))

  await waitFor(() => expect(createRepositorySkill).toHaveBeenCalledWith('sess_1', {
    name: 'review-code', description: 'Review code changes', instructions: '# Review', revision: undefined,
  }))
})

test('renders the information and empty states as regular cards', async () => {
  render(<RepositorySkills session={session} onOpenFile={vi.fn()} />)
  const heading = screen.getByRole('heading', { name: 'Repository skills' })
  expect(heading.closest('section')).toHaveClass('rounded-lg', 'border', 'bg-background/72', 'shadow-sm')
  const emptyState = (await screen.findByText('No repository skills')).closest('div')
  expect(emptyState).toHaveClass('border', 'border-border/80', 'bg-background/72', 'shadow-sm')
  expect(emptyState).not.toHaveClass('border-dashed')
  expect(emptyState?.parentElement).toHaveClass('w-full', 'flex-1')
  expect(emptyState?.parentElement).not.toHaveClass('max-w-5xl')
})

test('routes invalid skills to the Files editor', async () => {
  const onOpenFile = vi.fn()
  vi.mocked(listRepositorySkills).mockResolvedValue([{
    directory_name: 'broken-skill', name: 'broken-skill', description: '',
    path: '.agents/skills/broken-skill/SKILL.md', validation_errors: ['SKILL.md frontmatter is not closed'],
    resource_count: 2, editable: false, linked: false,
    claude_bridge: { status: 'missing', path: '.claude/skills/broken-skill' },
  }])
  const user = userEvent.setup()
  render(<RepositorySkills session={session} onOpenFile={onOpenFile} />)
  await user.click(await screen.findByRole('button', { name: 'Open SKILL.md' }))
  expect(onOpenFile).toHaveBeenCalledWith('.agents/skills/broken-skill/SKILL.md')
})

test('can keep an existing Claude-specific entry', async () => {
  vi.mocked(listRepositorySkills).mockResolvedValue([conflictingSkill])
  const user = userEvent.setup()
  const { unmount } = render(<RepositorySkills session={session} onOpenFile={vi.fn()} />)
  expect(await screen.findByText('Claude: an existing non-symlink entry is in the way')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Keep existing' }))
  expect(screen.queryByText('Claude: an existing non-symlink entry is in the way')).not.toBeInTheDocument()
  expect(screen.getByText('Claude kept existing')).toBeInTheDocument()

  unmount()
  render(<RepositorySkills session={session} onOpenFile={vi.fn()} />)
  expect(await screen.findByText('Claude kept existing')).toBeInTheDocument()
})

test('can replace a conflict with a backed-up Claude bridge', async () => {
  vi.mocked(listRepositorySkills).mockResolvedValue([conflictingSkill])
  vi.mocked(repairRepositorySkillClaudeBridge).mockResolvedValue({
    skill: { ...conflictingSkill, claude_bridge: { status: 'linked', path: '.claude/skills/review-code' } },
    backup_path: '.claude/skills/review-code.gorchestra-backup-20260901T120000Z',
  })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  const user = userEvent.setup()
  render(<RepositorySkills session={session} onOpenFile={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: 'Replace with bridge' }))
  await waitFor(() => expect(repairRepositorySkillClaudeBridge).toHaveBeenCalledWith('sess_1', 'review-code', true))
  expect(await screen.findByText(/previous entry is backed up at/)).toHaveTextContent('.claude/skills/review-code.gorchestra-backup-20260901T120000Z')
})
