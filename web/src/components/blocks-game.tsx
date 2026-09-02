import { Gamepad2, Pause, Play, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react'
import {
  blocksBoardHeight,
  blocksBoardWidth,
  blocksDropInterval,
  blocksGameReducer,
  createBlocksGame,
  ghostPiece,
  pieceCells,
  type BlocksCell,
  type BlocksGameState,
  type Tetromino,
} from '@/lib/blocks-game'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const highScoreStorageKey = 'gorchestra.blocks.high-score.v1'

export function BlocksGame({ active, className }: { active: boolean; className?: string }) {
  const [game, dispatch] = useReducer(blocksGameReducer, undefined, () => createBlocksGame())
  const [highScore, setHighScore] = useState(() => readHighScore())
  const activatedRef = useRef(false)
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (active && !activatedRef.current) {
      activatedRef.current = true
      return
    }
    if (!active && activatedRef.current) dispatch({ type: 'pause' })
  }, [active])

  useEffect(() => {
    if (!active || game.status !== 'playing') return
    const timer = window.setInterval(() => dispatch({ type: 'tick' }), blocksDropInterval(game.level))
    return () => window.clearInterval(timer)
  }, [active, game.level, game.status])

  useEffect(() => {
    if (game.score <= highScore) return
    setHighScore(game.score)
    window.localStorage.setItem(highScoreStorageKey, String(game.score))
  }, [game.score, highScore])

  useEffect(() => {
    function pauseForVisibility() {
      if (document.hidden) dispatch({ type: 'pause' })
    }
    function pauseForBlur() {
      dispatch({ type: 'pause' })
    }
    document.addEventListener('visibilitychange', pauseForVisibility)
    window.addEventListener('blur', pauseForBlur)
    return () => {
      document.removeEventListener('visibilitychange', pauseForVisibility)
      window.removeEventListener('blur', pauseForBlur)
    }
  }, [])

  const display = useMemo(() => displayedBoard(game), [game])
  const nextPiece = game.queue[0]

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest('button')) return
    const action = blocksActionForKey(event.key)
    if (!action) return
    event.preventDefault()
    dispatch(action)
  }

  function focusPanel(event: React.PointerEvent<HTMLElement>) {
    if (!(event.target as HTMLElement).closest('button')) panelRef.current?.focus()
  }

  return (
    <section
      ref={panelRef}
      tabIndex={0}
      aria-label="Blocks game"
      className={cn(
        'flex h-full min-h-0 flex-col rounded-md border border-border/70 bg-background/46 p-3 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      onKeyDown={handleKeyDown}
      onPointerDown={focusPanel}
    >
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <Gamepad2 className="size-3.5" aria-hidden="true" />
          <span>Blocks</span>
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            disabled={game.status === 'game-over'}
            aria-label={game.status === 'paused' ? 'Resume Blocks game' : 'Pause Blocks game'}
            onClick={() => {
              dispatch({ type: 'toggle-pause' })
              panelRef.current?.focus()
            }}
          >
            {game.status === 'paused' ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            aria-label="Start a new Blocks game"
            onClick={() => {
              dispatch({ type: 'restart' })
              panelRef.current?.focus()
            }}
          >
            <RotateCcw aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="mt-2 grid shrink-0 grid-cols-[1fr_auto] gap-2 text-[10px] text-muted-foreground">
        <div className="grid grid-cols-3 gap-1.5">
          <GameMetric label="Score" value={game.score} />
          <GameMetric label="Lines" value={game.lines} />
          <GameMetric label="Level" value={game.level} />
        </div>
        <NextPiece type={nextPiece} />
      </div>

      <div className="blocks-game-board-wrap mt-2 flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <div
          role="img"
          aria-label={`Blocks board, score ${game.score}, ${game.lines} lines, level ${game.level}`}
          className="blocks-game-board relative grid overflow-hidden rounded border border-border/80 bg-[hsl(var(--foreground)/0.035)] shadow-inner"
          style={{
            gridTemplateColumns: `repeat(${blocksBoardWidth}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${blocksBoardHeight}, minmax(0, 1fr))`,
          }}
        >
          {display.map((cell, index) => (
            <GameCell key={index} cell={cell.cell} ghost={cell.ghost} />
          ))}
          {game.status !== 'playing' ? (
            <div className="absolute inset-0 flex items-center justify-center bg-background/78 p-3 text-center backdrop-blur-[2px]">
              <div>
                <p className="text-sm font-semibold">{game.status === 'paused' ? 'Paused' : 'Game over'}</p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {game.status === 'paused' ? 'Press P to resume' : 'Press R for a new game'}
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <p className="mt-2 shrink-0 text-center text-[9px] leading-4 text-muted-foreground">
        ← → move · ↓ soft drop · ↑/X/Z rotate · Space drop · P pause · R restart
      </p>
      <p className="sr-only" aria-live="polite">
        Score {game.score}. High score {highScore}. {game.status === 'game-over' ? 'Game over.' : ''}
      </p>
      <p className="mt-0.5 shrink-0 text-center text-[9px] text-muted-foreground">Best {highScore.toLocaleString()}</p>
    </section>
  )
}

function GameMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded bg-surface-muted/72 px-1 py-1.5 text-center">
      <p className="truncate text-xs font-semibold tabular-nums text-foreground" title={value.toLocaleString()}>
        {value.toLocaleString()}
      </p>
      <p className="truncate uppercase tracking-[0.08em]">{label}</p>
    </div>
  )
}

function NextPiece({ type }: { type?: Tetromino }) {
  const cells = useMemo(() => {
    if (!type) return new Set<string>()
    return new Set(pieceCells({ type, rotation: 0, x: 0, y: 0 }).map(([x, y]) => `${x}:${y}`))
  }, [type])

  return (
    <div aria-label={`Next piece: ${type ?? 'none'}`} className="rounded bg-surface-muted/72 p-1">
      <div className="grid size-10 grid-cols-4 grid-rows-4">
        {Array.from({ length: 16 }, (_, index) => {
          const x = index % 4
          const y = Math.floor(index / 4)
          return <GameCell key={index} cell={cells.has(`${x}:${y}`) ? (type ?? null) : null} ghost={false} />
        })}
      </div>
    </div>
  )
}

function GameCell({ cell, ghost }: { cell: BlocksCell; ghost: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'min-h-0 min-w-0 border border-[hsl(var(--border)/0.12)]',
        cell && tetrominoClassName(cell),
        ghost && !cell && 'border-[hsl(var(--foreground)/0.28)] bg-[hsl(var(--foreground)/0.055)]',
      )}
    />
  )
}

function displayedBoard(game: BlocksGameState) {
  const cells = game.board.flat().map((cell) => ({ cell, ghost: false }))
  const ghost = ghostPiece(game)
  for (const [x, y] of pieceCells(ghost)) {
    if (y >= 0 && y < blocksBoardHeight) cells[y * blocksBoardWidth + x].ghost = true
  }
  for (const [x, y] of pieceCells(game.active)) {
    if (y >= 0 && y < blocksBoardHeight) cells[y * blocksBoardWidth + x] = { cell: game.active.type, ghost: false }
  }
  return cells
}

function tetrominoClassName(type: Tetromino) {
  switch (type) {
    case 'I':
      return 'border-cyan-300/70 bg-cyan-400'
    case 'J':
      return 'border-blue-400/70 bg-blue-500'
    case 'L':
      return 'border-orange-300/70 bg-orange-400'
    case 'O':
      return 'border-yellow-200/70 bg-yellow-300'
    case 'S':
      return 'border-emerald-300/70 bg-emerald-400'
    case 'T':
      return 'border-violet-300/70 bg-violet-500'
    case 'Z':
      return 'border-rose-300/70 bg-rose-500'
  }
}

function blocksActionForKey(key: string): Parameters<typeof blocksGameReducer>[1] | null {
  switch (key) {
    case 'ArrowLeft':
      return { type: 'move', dx: -1 }
    case 'ArrowRight':
      return { type: 'move', dx: 1 }
    case 'ArrowDown':
      return { type: 'soft-drop' }
    case 'ArrowUp':
    case 'x':
    case 'X':
      return { type: 'rotate', direction: 1 }
    case 'z':
    case 'Z':
      return { type: 'rotate', direction: -1 }
    case ' ':
      return { type: 'hard-drop' }
    case 'p':
    case 'P':
      return { type: 'toggle-pause' }
    case 'r':
    case 'R':
      return { type: 'restart' }
    default:
      return null
  }
}

function readHighScore() {
  if (typeof window === 'undefined') return 0
  const parsed = Number.parseInt(window.localStorage.getItem(highScoreStorageKey) ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}
