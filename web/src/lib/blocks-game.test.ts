import {
  blocksDropInterval,
  blocksGameReducer,
  createBlocksGame,
  emptyBlocksBoard,
  pieceCells,
  type BlocksGameState,
} from '@/lib/blocks-game'

test('a seeded game starts with one complete seven-piece bag', () => {
  const game = createBlocksGame(12345)
  const firstBag = [game.active.type, ...game.queue.slice(0, 6)]

  expect(new Set(firstBag)).toEqual(new Set(['I', 'J', 'L', 'O', 'S', 'T', 'Z']))
  expect(game.queue[0]).toBeTruthy()
})

test('movement, soft drop, and hard drop update the active piece and score', () => {
  const start = gameWith({ active: { type: 'T', rotation: 0, x: 3, y: 0 } })
  const moved = blocksGameReducer(start, { type: 'move', dx: -1 })
  const softened = blocksGameReducer(moved, { type: 'soft-drop' })
  const dropped = blocksGameReducer(softened, { type: 'hard-drop' })

  expect(moved.active.x).toBe(2)
  expect(softened.active.y).toBe(1)
  expect(softened.score).toBe(1)
  expect(dropped.score).toBeGreaterThan(1)
  expect(dropped.board.flat().filter(Boolean)).toHaveLength(4)
})

test('rotation uses a wall kick when the rotated shape would leave the board', () => {
  const start = gameWith({ active: { type: 'T', rotation: 1, x: -1, y: 2 } })

  const rotated = blocksGameReducer(start, { type: 'rotate', direction: 1 })

  expect(rotated.active.rotation).toBe(2)
  expect(rotated.active.x).toBe(0)
  expect(pieceCells(rotated.active).every(([x]) => x >= 0)).toBe(true)
})

test('line clears score against the current level and advance every ten lines', () => {
  const board = emptyBlocksBoard()
  board[19] = board[19].map((_, x) => (x >= 3 && x <= 6 ? null : 'J'))
  const start = gameWith({
    board,
    active: { type: 'I', rotation: 0, x: 3, y: 18 },
    lines: 9,
  })

  const cleared = blocksGameReducer(start, { type: 'hard-drop' })

  expect(cleared.lines).toBe(10)
  expect(cleared.level).toBe(2)
  expect(cleared.score).toBe(100)
  expect(cleared.board[19].every((cell) => cell === null)).toBe(true)
})

test('clearing four rows awards a four-line score', () => {
  const board = emptyBlocksBoard()
  for (let y = 16; y < 20; y += 1) board[y] = board[y].map((_, x) => (x === 5 ? null : 'L'))
  const start = gameWith({ board, active: { type: 'I', rotation: 1, x: 3, y: 16 } })

  const cleared = blocksGameReducer(start, { type: 'hard-drop' })

  expect(cleared.lines).toBe(4)
  expect(cleared.score).toBe(800)
})

test('locking a piece above the ceiling ends the game', () => {
  const board = emptyBlocksBoard()
  board[1][4] = 'Z'
  const start = gameWith({ board, active: { type: 'O', rotation: 0, x: 3, y: -1 } })

  expect(blocksGameReducer(start, { type: 'tick' }).status).toBe('game-over')
})

test('pause gates gameplay and gravity has a floor', () => {
  const start = createBlocksGame(99)
  const paused = blocksGameReducer(start, { type: 'pause' })

  expect(blocksGameReducer(paused, { type: 'soft-drop' })).toBe(paused)
  expect(blocksGameReducer(paused, { type: 'resume' }).status).toBe('playing')
  expect(blocksDropInterval(1)).toBe(800)
  expect(blocksDropInterval(100)).toBe(100)
})

function gameWith(overrides: Partial<BlocksGameState>): BlocksGameState {
  return { ...createBlocksGame(42), ...overrides }
}
