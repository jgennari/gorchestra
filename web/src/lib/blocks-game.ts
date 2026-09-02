export const blocksBoardWidth = 10
export const blocksBoardHeight = 20

export type Tetromino = 'I' | 'J' | 'L' | 'O' | 'S' | 'T' | 'Z'
export type BlocksCell = Tetromino | null
export type BlocksBoard = BlocksCell[][]
export type BlocksGameStatus = 'playing' | 'paused' | 'game-over'

export type FallingPiece = {
  type: Tetromino
  rotation: number
  x: number
  y: number
}

export type BlocksGameState = {
  board: BlocksBoard
  active: FallingPiece
  queue: Tetromino[]
  score: number
  lines: number
  level: number
  status: BlocksGameStatus
  seed: number
}

export type BlocksGameAction =
  | { type: 'tick' }
  | { type: 'move'; dx: -1 | 1 }
  | { type: 'soft-drop' }
  | { type: 'hard-drop' }
  | { type: 'rotate'; direction: -1 | 1 }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'toggle-pause' }
  | { type: 'restart'; seed?: number }

const tetrominoes: Tetromino[] = ['I', 'J', 'L', 'O', 'S', 'T', 'Z']

const shapes: Record<Tetromino, ReadonlyArray<ReadonlyArray<readonly [number, number]>>> = {
  I: [
    [[0, 1], [1, 1], [2, 1], [3, 1]],
    [[2, 0], [2, 1], [2, 2], [2, 3]],
    [[0, 2], [1, 2], [2, 2], [3, 2]],
    [[1, 0], [1, 1], [1, 2], [1, 3]],
  ],
  J: [
    [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [2, 2]],
    [[1, 0], [1, 1], [0, 2], [1, 2]],
  ],
  L: [
    [[2, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [1, 2], [2, 2]],
    [[0, 1], [1, 1], [2, 1], [0, 2]],
    [[0, 0], [1, 0], [1, 1], [1, 2]],
  ],
  O: [
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
  ],
  S: [
    [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[1, 0], [1, 1], [2, 1], [2, 2]],
    [[1, 1], [2, 1], [0, 2], [1, 2]],
    [[0, 0], [0, 1], [1, 1], [1, 2]],
  ],
  T: [
    [[1, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [1, 2]],
    [[1, 0], [0, 1], [1, 1], [1, 2]],
  ],
  Z: [
    [[0, 0], [1, 0], [1, 1], [2, 1]],
    [[2, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [1, 2], [2, 2]],
    [[1, 0], [0, 1], [1, 1], [0, 2]],
  ],
}

const jlstzKicks: Record<string, ReadonlyArray<readonly [number, number]>> = {
  '0>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '1>0': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '1>2': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '2>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '2>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '3>2': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '3>0': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '0>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
}

const iKicks: Record<string, ReadonlyArray<readonly [number, number]>> = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
}

export function createBlocksGame(seed = Date.now()): BlocksGameState {
  const normalizedSeed = normalizeSeed(seed)
  const filled = fillQueue([], normalizedSeed, 8)
  const [first, ...queue] = filled.queue
  return {
    board: emptyBlocksBoard(),
    active: spawnPiece(first),
    queue,
    score: 0,
    lines: 0,
    level: 1,
    status: 'playing',
    seed: filled.seed,
  }
}

export function blocksGameReducer(state: BlocksGameState, action: BlocksGameAction): BlocksGameState {
  if (action.type === 'restart') return createBlocksGame(action.seed ?? Date.now())
  if (action.type === 'pause') return state.status === 'playing' ? { ...state, status: 'paused' } : state
  if (action.type === 'resume') return state.status === 'paused' ? { ...state, status: 'playing' } : state
  if (action.type === 'toggle-pause') {
    if (state.status === 'game-over') return state
    return { ...state, status: state.status === 'playing' ? 'paused' : 'playing' }
  }
  if (state.status !== 'playing') return state

  switch (action.type) {
    case 'tick':
      return descendOrLock(state, 0)
    case 'soft-drop':
      return descendOrLock(state, 1)
    case 'hard-drop':
      return hardDrop(state)
    case 'move':
      return moveActive(state, action.dx, 0)
    case 'rotate':
      return rotateActive(state, action.direction)
  }
}

export function blocksDropInterval(level: number) {
  return Math.max(100, 800 - Math.max(0, level - 1) * 75)
}

export function pieceCells(piece: FallingPiece): Array<[number, number]> {
  const rotation = normalizeRotation(piece.rotation)
  return shapes[piece.type][rotation].map(([x, y]) => [piece.x + x, piece.y + y])
}

export function ghostPiece(state: BlocksGameState): FallingPiece {
  let ghost = state.active
  while (canPlace(state.board, { ...ghost, y: ghost.y + 1 })) {
    ghost = { ...ghost, y: ghost.y + 1 }
  }
  return ghost
}

export function canPlace(board: BlocksBoard, piece: FallingPiece) {
  return pieceCells(piece).every(([x, y]) => {
    if (x < 0 || x >= blocksBoardWidth || y >= blocksBoardHeight) return false
    return y < 0 || board[y][x] === null
  })
}

export function emptyBlocksBoard(): BlocksBoard {
  return Array.from({ length: blocksBoardHeight }, () => Array<BlocksCell>(blocksBoardWidth).fill(null))
}

function moveActive(state: BlocksGameState, dx: number, dy: number) {
  const active = { ...state.active, x: state.active.x + dx, y: state.active.y + dy }
  return canPlace(state.board, active) ? { ...state, active } : state
}

function descendOrLock(state: BlocksGameState, dropScore: number) {
  const active = { ...state.active, y: state.active.y + 1 }
  if (canPlace(state.board, active)) {
    return { ...state, active, score: state.score + dropScore }
  }
  return lockPiece(state)
}

function hardDrop(state: BlocksGameState) {
  let active = state.active
  let distance = 0
  while (canPlace(state.board, { ...active, y: active.y + 1 })) {
    active = { ...active, y: active.y + 1 }
    distance += 1
  }
  return lockPiece({ ...state, active, score: state.score + distance * 2 })
}

function rotateActive(state: BlocksGameState, direction: -1 | 1) {
  if (state.active.type === 'O') return state
  const from = normalizeRotation(state.active.rotation)
  const to = normalizeRotation(from + direction)
  const kicks = state.active.type === 'I' ? iKicks[`${from}>${to}`] : jlstzKicks[`${from}>${to}`]
  for (const [dx, dy] of kicks ?? [[0, 0] as const]) {
    const active = { ...state.active, rotation: to, x: state.active.x + dx, y: state.active.y + dy }
    if (canPlace(state.board, active)) return { ...state, active }
  }
  return state
}

function lockPiece(state: BlocksGameState): BlocksGameState {
  const cells = pieceCells(state.active)
  if (cells.some(([, y]) => y < 0)) return { ...state, status: 'game-over' }

  const board = state.board.map((row) => [...row])
  for (const [x, y] of cells) board[y][x] = state.active.type

  const remaining = board.filter((row) => row.some((cell) => cell === null))
  const cleared = blocksBoardHeight - remaining.length
  const clearedBoard = [
    ...Array.from({ length: cleared }, () => Array<BlocksCell>(blocksBoardWidth).fill(null)),
    ...remaining,
  ]
  const lines = state.lines + cleared
  const level = Math.floor(lines / 10) + 1
  const lineScores = [0, 100, 300, 500, 800]
  const score = state.score + (lineScores[cleared] ?? 0) * state.level
  const filled = fillQueue(state.queue, state.seed, 8)
  const [next, ...queue] = filled.queue
  const active = spawnPiece(next)
  const status: BlocksGameStatus = canPlace(clearedBoard, active) ? 'playing' : 'game-over'

  return { board: clearedBoard, active, queue, score, lines, level, status, seed: filled.seed }
}

function spawnPiece(type: Tetromino): FallingPiece {
  return { type, rotation: 0, x: 3, y: -1 }
}

function fillQueue(queue: Tetromino[], seed: number, minimum: number) {
  const next = [...queue]
  let nextSeed = seed
  while (next.length < minimum) {
    const bag = [...tetrominoes]
    for (let index = bag.length - 1; index > 0; index -= 1) {
      const random = nextRandom(nextSeed)
      nextSeed = random.seed
      const swapIndex = Math.floor(random.value * (index + 1))
      ;[bag[index], bag[swapIndex]] = [bag[swapIndex], bag[index]]
    }
    next.push(...bag)
  }
  return { queue: next, seed: nextSeed }
}

function nextRandom(seed: number) {
  let value = seed | 0
  value ^= value << 13
  value ^= value >>> 17
  value ^= value << 5
  const nextSeed = value >>> 0 || 0x9e3779b9
  return { seed: nextSeed, value: nextSeed / 0x100000000 }
}

function normalizeSeed(seed: number) {
  const normalized = Number.isFinite(seed) ? Math.floor(seed) >>> 0 : 0
  return normalized || 0x9e3779b9
}

function normalizeRotation(rotation: number) {
  return ((rotation % 4) + 4) % 4
}
