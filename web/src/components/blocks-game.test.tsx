import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BlocksGame } from '@/components/blocks-game'

beforeEach(() => {
  window.localStorage.clear()
})

test('focused keyboard controls move pieces and update the score', async () => {
  render(<BlocksGame active />)
  const panel = screen.getByRole('region', { name: 'Blocks game' })

  fireEvent.keyDown(panel, { key: 'ArrowDown' })

  expect(screen.getByRole('img', { name: /Blocks board, score 1,/ })).toBeInTheDocument()
  await waitFor(() => expect(window.localStorage.getItem('gorchestra.blocks.high-score.v1')).toBe('1'))
})

test('leaving the rail mode pauses and preserves the current game', () => {
  const { rerender } = render(<BlocksGame active />)
  const panel = screen.getByRole('region', { name: 'Blocks game' })
  fireEvent.keyDown(panel, { key: 'ArrowDown' })

  rerender(<BlocksGame active={false} />)
  rerender(<BlocksGame active />)

  expect(screen.getByText('Paused')).toBeInTheDocument()
  expect(screen.getByRole('img', { name: /Blocks board, score 1,/ })).toBeInTheDocument()
})

test('keyboard input is ignored while paused and resume restores play', () => {
  render(<BlocksGame active />)
  const panel = screen.getByRole('region', { name: 'Blocks game' })

  fireEvent.keyDown(panel, { key: 'p' })
  fireEvent.keyDown(panel, { key: 'ArrowDown' })
  expect(screen.getByRole('img', { name: /Blocks board, score 0,/ })).toBeInTheDocument()

  fireEvent.keyDown(panel, { key: 'p' })
  fireEvent.keyDown(panel, { key: 'ArrowDown' })
  expect(screen.getByRole('img', { name: /Blocks board, score 1,/ })).toBeInTheDocument()
})

test('a stored high score is shown on a fresh game', () => {
  window.localStorage.setItem('gorchestra.blocks.high-score.v1', '4321')

  render(<BlocksGame active />)

  expect(screen.getByText('Best 4,321')).toBeInTheDocument()
})
