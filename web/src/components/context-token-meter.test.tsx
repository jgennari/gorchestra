import { render, screen } from '@testing-library/react'
import { ContextTokenMeter } from '@/components/context-token-meter'
import type { TokenUsageSummary } from '@/lib/events'

test('mini meter shows current context, not cumulative tokens', () => {
  render(<ContextTokenMeter usage={usage(128_000, 256_000)} compact />)
  expect(screen.getByText('128k / 256k')).toBeInTheDocument()
  expect(screen.getByText('50%')).toBeInTheDocument()
  expect(screen.queryByText(/current|cumulative/)).not.toBeInTheDocument()
  const meter = screen.getByRole('meter', { name: 'Context token usage' })
  expect(meter).toHaveAttribute('aria-valuenow', '128000')
  expect(meter).toHaveAttribute('aria-valuemax', '256000')
  expect(meter.firstElementChild).toHaveStyle({ width: '50%' })
  expect(meter.firstElementChild).toHaveClass('bg-primary')
})

test.each([
  [140_000, '70%', 'bg-[hsl(var(--warning))]', '70%'],
  [180_000, '90%', 'bg-destructive', '90%'],
  [220_000, '110%', 'bg-destructive', '100%'],
])('shows pressure for %s tokens and caps the bar to the window', (tokens, percentage, color, width) => {
  render(<ContextTokenMeter usage={usage(tokens, 200_000)} compact />)
  expect(screen.getByText(percentage)).toBeInTheDocument()
  const meter = screen.getByRole('meter')
  expect(meter.firstElementChild).toHaveClass(color)
  expect(meter.firstElementChild).toHaveStyle({ width })
  expect(meter).toHaveAttribute('aria-valuenow', String(Math.min(tokens, 200_000)))
  expect(meter).toHaveAttribute('aria-valuetext', expect.stringContaining(percentage))
})

test('missing usage is not reported as zero, and updates render in place', () => {
  const { rerender } = render(<ContextTokenMeter usage={null} compact />)
  expect(screen.getByText('No token usage yet')).toBeInTheDocument()
  expect(screen.queryByRole('meter')).not.toBeInTheDocument()
  rerender(<ContextTokenMeter usage={usage(12_000, 200_000)} compact />)
  expect(screen.getByText('12k / 200k')).toBeInTheDocument()
  expect(screen.queryByText('No token usage yet')).not.toBeInTheDocument()
})

test('full meter preserves desktop counts and supports context-only providers', () => {
  render(<ContextTokenMeter usage={{ ...usage(53_000, 200_000), kind: 'context' }} />)
  expect(screen.getByText('53k / 200k current')).toBeInTheDocument()
  expect(screen.getByText('27%')).toBeInTheDocument()
})

function usage(tokens: number, modelContextWindow: number): TokenUsageSummary {
  const snapshot = { totalTokens: tokens, inputTokens: tokens, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 }
  return { total: { ...snapshot, totalTokens: 8_000_000 }, last: snapshot, modelContextWindow, seq: 1, updatedAt: '2026-09-07T12:00:00Z' }
}

test('unknown context windows show usage without a guessed percentage', () => {
  render(<ContextTokenMeter usage={{ ...usage(53_000, 200_000), modelContextWindow: null }} compact />)
  expect(screen.getByText('53k current · limit unknown')).toBeInTheDocument()
  expect(screen.queryByRole('meter')).not.toBeInTheDocument()
})

test('missing current context never falls back to cumulative usage', () => {
  render(<ContextTokenMeter usage={{ ...usage(53_000, 200_000), last: null }} />)
  expect(screen.getByText('Current context unavailable')).toBeInTheDocument()
  expect(screen.queryByRole('meter')).not.toBeInTheDocument()
})
