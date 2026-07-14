import { access, mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const tmpDir = join(repoRoot, '.tmp', 'human')
const launchAgentLabel = process.env.GORCHESTRA_HUMAN_LAUNCH_AGENT ?? 'com.joey.gorchestra-human'
const launchAgentPath =
  process.env.GORCHESTRA_HUMAN_LAUNCH_AGENT_PATH ??
  join(homedir(), 'Library', 'LaunchAgents', `${launchAgentLabel}.plist`)
const launchDomain = `gui/${typeof process.getuid === 'function' ? process.getuid() : 501}`
const launchTarget = `${launchDomain}/${launchAgentLabel}`
const backendPort = process.env.GORCHESTRA_HUMAN_PORT ?? '18080'
const webPort = process.env.GORCHESTRA_HUMAN_WEB_PORT ?? '15173'
const dbPath = process.env.GORCHESTRA_HUMAN_DB ?? join(tmpDir, 'sessions.db')
const workspacePath = process.env.GORCHESTRA_HUMAN_WORKSPACE ?? homedir()
const stdoutPath = process.env.GORCHESTRA_HUMAN_STDOUT ?? join(tmpDir, 'launchd.out.log')
const stderrPath = process.env.GORCHESTRA_HUMAN_STDERR ?? join(tmpDir, 'launchd.err.log')
const tailnetURL = process.env.GORCHESTRA_HUMAN_TAILNET_URL ?? 'http://gorchestra.dev.gennari.industries'
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
      await restart()
      break
    case 'reset':
      await reset()
      break
    case 'status':
      await status()
      break
    case 'logs':
      await logs(false)
      break
    case 'attach':
      await logs(true)
      break
    default:
      usage()
      process.exit(1)
  }
}

async function start() {
  await requireLaunchAgent()
  await mkdir(tmpDir, { recursive: true })

  if (launchAgentState().loaded) {
    console.log(`[human-dev] LaunchAgent ${launchAgentLabel} is already loaded`)
    await status()
    return
  }

  const result = run(['launchctl', 'bootstrap', launchDomain, launchAgentPath])
  if (result.exitCode !== 0) {
    fail(`failed to load LaunchAgent: ${result.stderr}`)
  }

  console.log(`[human-dev] loaded LaunchAgent ${launchAgentLabel}`)
  await waitForServer()
  await status()
}

async function stop() {
  if (!launchAgentState().loaded) {
    console.log(`[human-dev] LaunchAgent ${launchAgentLabel} is not loaded`)
    return
  }

  const result = run(['launchctl', 'bootout', launchTarget])
  if (result.exitCode !== 0) {
    fail(`failed to unload LaunchAgent: ${result.stderr}`)
  }

  for (let i = 0; i < 20; i++) {
    if (!launchAgentState().loaded) {
      console.log(`[human-dev] unloaded LaunchAgent ${launchAgentLabel}`)
      return
    }
    await sleep(250)
  }

  fail(`LaunchAgent ${launchAgentLabel} did not stop`)
}

async function restart() {
  await requireLaunchAgent()
  if (!launchAgentState().loaded) {
    await start()
    return
  }

  const result = run(['launchctl', 'kickstart', '-k', launchTarget])
  if (result.exitCode !== 0) {
    fail(`failed to restart LaunchAgent: ${result.stderr}`)
  }

  console.log(`[human-dev] restarted LaunchAgent ${launchAgentLabel}`)
  await waitForServer()
  await status()
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
  const service = launchAgentState()
  const backendURL = `http://127.0.0.1:${backendPort}`
  const frontendURL = `http://127.0.0.1:${webPort}`
  const [backendHealth, frontendHealth, tailnetHealth] = await Promise.all([
    probe(`${backendURL}/api/health`),
    probe(frontendURL),
    probe(`${tailnetURL}/api/health`),
  ])

  console.log(`[human-dev] service: ${launchAgentLabel}`)
  console.log(`[human-dev] state: ${service.loaded ? service.state || 'loaded' : 'stopped'}${service.pid ? ` (pid ${service.pid})` : ''}`)
  console.log(`[human-dev] backend: ${backendURL} (${backendHealth})`)
  console.log(`[human-dev] frontend: ${frontendURL} (${frontendHealth})`)
  console.log(`[human-dev] tailnet: ${tailnetURL} (${tailnetHealth})`)
  console.log(`[human-dev] database: ${dbPath}`)
  console.log(`[human-dev] workspace: ${workspacePath}`)
  console.log(`[human-dev] LaunchAgent: ${launchAgentPath}`)
}

async function logs(follow: boolean) {
  await mkdir(tmpDir, { recursive: true })
  const lines = Bun.argv[3] ?? '200'
  const args = ['tail', ...(follow ? ['-f'] : []), '-n', lines, stdoutPath, stderrPath]
  const result = run(args, follow ? { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' } : {})
  if (result.exitCode !== 0) {
    fail(result.stderr || 'failed to read LaunchAgent logs')
  }
  if (!follow) {
    process.stdout.write(result.stdout)
  }
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    const [backend, frontend] = await Promise.all([
      probe(`http://127.0.0.1:${backendPort}/api/health`),
      probe(`http://127.0.0.1:${webPort}`),
    ])
    if (backend === 'ok' && frontend === 'ok') {
      return
    }
    await sleep(500)
  }

  console.log('[human-dev] server did not become fully healthy before timeout; check logs')
}

async function probe(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return response.ok ? 'ok' : `http ${response.status}`
  } catch {
    return 'offline'
  }
}

function launchAgentState() {
  const result = run(['launchctl', 'print', launchTarget])
  if (result.exitCode !== 0) {
    return { loaded: false, state: '', pid: '' }
  }

  return {
    loaded: true,
    state: result.stdout.match(/^\s*state = (.+)$/m)?.[1]?.trim() ?? '',
    pid: result.stdout.match(/^\s*pid = (\d+)$/m)?.[1] ?? '',
  }
}

async function requireLaunchAgent() {
  try {
    await access(launchAgentPath)
  } catch {
    fail(`LaunchAgent plist not found at ${launchAgentPath}`)
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
  start     Load the persistent human-test LaunchAgent
  stop      Unload the LaunchAgent
  restart   Restart the LaunchAgent
  reset     Stop, delete the human-test database, and start
  status    Print LaunchAgent state, URLs, and health
  logs      Print recent LaunchAgent logs
  attach    Follow LaunchAgent logs
`)
}

void main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
