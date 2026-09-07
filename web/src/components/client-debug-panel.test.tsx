import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ClientDebugPanel } from '@/components/client-debug-panel'
import { copyText } from '@/lib/clipboard'
import type { ClientDebugSnapshot } from '@/lib/client-debug'

vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn().mockResolvedValue(undefined), clipboardCopyErrorMessage: 'Copy failed' }))

const snapshot: ClientDebugSnapshot = {
  stream: { connection: 'connected', lastEvent: 'tool.call.completed' },
  history: { sequences: 'server 10 · local durable 10' },
  message: 'agent #10',
  preview: 'Private message preview',
}

test('samples only the panel, supports collapse, and stops sampling on unmount', () => {
  vi.useFakeTimers()
  try {
    const read = vi.fn(() => snapshot)
    const { unmount } = render(<ClientDebugPanel readSnapshot={read} onClose={() => {}} />)
    expect(read).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Private message preview')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Client debug/ }))
    expect(screen.getByText('Private message preview')).not.toBeVisible()
    expect(screen.getByRole('button', { name: /Client debug/ })).toHaveAttribute('aria-expanded', 'false')
    act(() => vi.advanceTimersByTime(1000))
    expect(read).toHaveBeenCalledTimes(2)
    unmount()
    act(() => vi.advanceTimersByTime(2000))
    expect(read).toHaveBeenCalledTimes(2)
  } finally { vi.useRealTimers() }
})

test('exports local diagnostics without message contents and closes from its button', async () => {
  const close = vi.fn()
  render(<ClientDebugPanel readSnapshot={() => snapshot} onClose={close} />)
  fireEvent.click(screen.getByRole('button', { name: 'Copy debug diagnostics' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Copied'))
  const output = vi.mocked(copyText).mock.calls.at(-1)![0]
  expect(output).toContain('tool.call.completed')
  expect(output).not.toContain('Private message preview')
  fireEvent.click(screen.getByRole('button', { name: 'Close debug view' }))
  expect(close).toHaveBeenCalledOnce()
})
