import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { SessionSchedules } from '@/components/session-schedules'
import { createSchedule, listScheduleOccurrences, listSchedules } from '@/lib/api'

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    listSchedules: vi.fn(),
    listScheduleOccurrences: vi.fn(),
    createSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    runScheduleNow: vi.fn(),
    cancelScheduleOccurrence: vi.fn(),
  }
})

const session = {
  id: 'sess_1', title: 'Scheduled session', agent_type: 'fake' as const, status: 'idle' as const,
  workspace_path: '/repo', event_count: 0, tool_count: 0, created_at: '2026-09-01T12:00:00Z',
  updated_at: '2026-09-01T12:00:00Z', completed_at: null, archived_at: null,
}

beforeEach(() => {
  vi.mocked(listSchedules).mockResolvedValue([])
  vi.mocked(listScheduleOccurrences).mockResolvedValue([])
  vi.mocked(createSchedule).mockResolvedValue({
    id: 'sched_1', session_id: 'sess_1', name: 'Morning check', prompt: 'Inspect repository',
    cadence: { kind: 'daily', time: '09:00' }, timezone: 'UTC', enabled: true,
    next_run_at: '2026-09-02T09:00:00Z', pending_count: 0,
    created_at: '2026-09-01T12:00:00Z', updated_at: '2026-09-01T12:00:00Z',
  })
})

test('creates a guided daily schedule', async () => {
  const user = userEvent.setup()
  render(<SessionSchedules session={session} />)
  await screen.findByText('No scheduled tasks')
  await user.click(screen.getByRole('button', { name: 'New schedule' }))
  const textareas = screen.getAllByRole('textbox')
  const prompt = textareas.find((element) => element.tagName === 'TEXTAREA')
  expect(prompt).toBeDefined()
  await user.type(prompt!, 'Inspect repository')
  const timezone = screen.getByLabelText('Timezone')
  fireEvent.change(timezone, { target: { value: 'UTC' } })
  await user.click(screen.getByRole('button', { name: 'Save schedule' }))
  await waitFor(() => expect(createSchedule).toHaveBeenCalledWith('sess_1', expect.objectContaining({
    prompt: 'Inspect repository', timezone: 'UTC', cadence: { kind: 'daily', time: '09:00' }, enabled: true,
  })))
})

test('renders the empty state as a regular card', async () => {
  render(<SessionSchedules session={session} />)

  const emptyState = (await screen.findByText('No scheduled tasks')).closest('div')
  expect(emptyState).toHaveClass('border', 'border-border/80', 'bg-background/72', 'shadow-sm')
  expect(emptyState).not.toHaveClass('border-dashed')
  expect(emptyState?.parentElement).toHaveClass('w-full', 'flex-1')
  expect(emptyState?.parentElement).not.toHaveClass('max-w-5xl')
})
