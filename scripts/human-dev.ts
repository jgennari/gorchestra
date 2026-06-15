import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const tmpDir = join(repoRoot, '.tmp', 'human')
const sessionName = process.env.GORCHESTRA_HUMAN_TMUX ?? 'gorchestra-human'
const backendPort = process.env.GORCHESTRA_HUMAN_PORT ?? '18080'
const webPort = process.env.GORCHESTRA_HUMAN_WEB_PORT ?? '15173'
const dbPath = process.env.GORCHESTRA_HUMAN_DB ?? join(tmpDir, 'sessions.db')
const workspacePath = process.env.GORCHESTRA_HUMAN_WORKSPACE ?? homedir()
const command = Bun.argv[2] ?? 'start'

type RunOptions = {
  stdout?: 'pipe' | 'inherit'
  stderr?: 'pipe' | 'inherit'
  stdin?: 'inherit'
}

async function main() {
  switch (command) {
    case 'start':
      await start()
      break
    case 'stop':
      await stop()
      break
    case 'restart':
      await stop()
      await start()
      break
    case 'reset':
      await reset()
      break
    case 'status':
      await status()
      break
    case 'logs':
      logs()
      break
    case 'attach':
      attach()
      break
    default:
      usage()
      process.exit(1)
  }
}

async function start() {
  requireTmux()
  await mkdir(dirname(dbPath), { recursive: true })

  if (sessionExists()) {
    console.log(`[human-dev] tmux session ${sessionName} is already running`)
    await status()
    return
  }

  const env = [
    `PORT=${shellQuote(backendPort)}`,
    `WEB_PORT=${shellQuote(webPort)}`,
    `GORCHESTRA_DB=${shellQuote(dbPath)}`,
    `GORCHESTRA_WORKSPACE=${shellQuote(workspacePath)}`,
  ]

  if (process.env.VITE_ALLOWED_HOSTS) {
    env.push(`VITE_ALLOWED_HOSTS=${shellQuote(process.env.VITE_ALLOWED_HOSTS)}`)
  }

  const shellCommand = `${env.join(' ')} bun run dev:tailnet`
  const result = run([
    'tmux',
    'new-session',
    '-d',
    '-s',
    sessionName,
    '-c',
    repoRoot,
    shellCommand,
  ])
  if (result.exitCode !== 0) {
    fail(`failed to start tmux session: ${result.stderr}`)
  }

  console.log(`[human-dev] started tmux session ${sessionName}`)
  await waitForServer()
  await status()
}

async function stop() {
  requireTmux()

  if (!sessionExists()) {
    console.log(`[human-dev] tmux session ${sessionName} is not running`)
    return
  }

  run(['tmux', 'send-keys', '-t', sessionName, 'C-c'])

  for (let i = 0; i < 20; i++) {
    if (!sessionExists()) {
      console.log(`[human-dev] stopped tmux session ${sessionName}`)
      return
    }
    await sleep(250)
  }

  run(['tmux', 'kill-session', '-t', sessionName])
  console.log(`[human-dev] killed tmux session ${sessionName}`)
}

async function reset() {
  await stop()

  await Promise.all([
    rm(dbPath, { force: true }),
    rm(`${dbPath}-shm`, { force: true }),
    rm(`${dbPath}-wal`, { force: true }),
  ])
  console.log(`[human-dev] reset database ${dbPath}`)

  await start()
}

async function status() {
  const ip = await tailscaleIP()
  const running = sessionExists()
  const backendURL = `http://localhost:${backendPort}`
  const frontendURL = `http://127.0.0.1:${webPort}`
  const tailnetURL = ip ? `http://${ip}:${webPort}` : ''
  const backendHealth = await probe(`${backendURL}/api/health`)
  const frontendHealth = await probe(frontendURL)

  console.log(`[human-dev] session: ${sessionName}`)
  console.log(`[human-dev] state: ${running ? 'running' : 'stopped'}`)
  console.log(`[human-dev] backend: ${backendURL} (${backendHealth})`)
  console.log(`[human-dev] frontend: ${frontendURL} (${frontendHealth})`)
  if (tailnetURL) {
    console.log(`[human-dev] tailnet: ${tailnetURL}`)
  } else {
    console.log('[human-dev] tailnet: unavailable')
  }
  console.log(`[human-dev] database: ${dbPath}`)
  console.log(`[human-dev] workspace: ${workspacePath}`)
}

function logs() {
  requireTmux()
  if (!sessionExists()) {
    fail(`tmux session ${sessionName} is not running`)
  }

  const lines = Bun.argv[3] ?? '200'
  const result = run(['tmux', 'capture-pane', '-p', '-t', sessionName, '-S', `-${lines}`])
  if (result.exitCode !== 0) {
    fail(result.stderr)
  }

  process.stdout.write(result.stdout)
}

function attach() {
  requireTmux()
  if (!sessionExists()) {
    fail(`tmux session ${sessionName} is not running`)
  }

  const result = run(['tmux', 'attach-session', '-t', sessionName], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  process.exit(result.exitCode)
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    const backend = await probe(`http://localhost:${backendPort}/api/health`)
    const frontend = await probe(`http://127.0.0.1:${webPort}`)
    if (backend === 'ok' && frontend === 'ok') {
      return
    }
    await sleep(500)
  }

  console.log('[human-dev] server did not become fully healthy before timeout; check logs')
}

async function tailscaleIP() {
  const result = run(['tailscale', 'ip', '-4'])
  if (result.exitCode !== 0) {
    return ''
  }

  return result.stdout.trim().split('\n')[0] ?? ''
}

async function probe(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return response.ok ? 'ok' : `http ${response.status}`
  } catch {
    return 'offline'
  }
}

function sessionExists() {
  return run(['tmux', 'has-session', '-t', sessionName]).exitCode === 0
}

function requireTmux() {
  if (run(['tmux', '-V']).exitCode !== 0) {
    fail('tmux is required for the persistent human dev server')
  }
}

function run(args: string[], options: RunOptions = {}) {
  try {
    const proc = Bun.spawnSync(args, {
      cwd: repoRoot,
      stdin: options.stdin,
      stdout: options.stdout ?? 'pipe',
      stderr: options.stderr ?? 'pipe',
    })

    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout ? new TextDecoder().decode(proc.stdout) : '',
      stderr: proc.stderr ? new TextDecoder().decode(proc.stderr) : '',
    }
  } catch (error) {
    return {
      exitCode: 127,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fail(message: string): never {
  console.error(`[human-dev] ${message.trim()}`)
  process.exit(1)
}

function usage() {
  console.log(`Usage: bun run scripts/human-dev.ts <command>

Commands:
  start     Start the persistent tailnet dev server
  stop      Stop the tmux session
  restart   Stop and start the tmux session
  reset     Stop, delete the human dev database, and start
  status    Print server URLs and health
  logs      Print recent tmux pane output
  attach    Attach to the tmux session
`)
}

void main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
