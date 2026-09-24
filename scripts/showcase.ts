import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const stateDir = join(repoRoot, '.tmp', 'showcase')
const dbPath = join(stateDir, 'sessions.db')
const binaryPath = join(stateDir, 'threave')
const workspace = '/tmp/threave-showcase-workspace'
const home = '/tmp/threave-showcase-home'
const homeMarker = join(home, '.threave-showcase')
const args = new Set(Bun.argv.slice(2))

if (args.has('--reset')) {
  let serverIsRunning = false
  try {
    await fetch('http://127.0.0.1:18180/api/health', { signal: AbortSignal.timeout(800) })
    serverIsRunning = true
  } catch { /* Port is closed. */ }
  if (serverIsRunning) throw new Error('stop the showcase server before resetting its database')
  if (existsSync(workspace) && !existsSync(join(workspace, '.threave-showcase'))) {
    throw new Error(`refusing to remove an unmarked workspace at ${workspace}`)
  }
  if (existsSync(home) && !existsSync(homeMarker) && (await readdir(home)).length > 0) {
    throw new Error(`refusing to remove an unmarked home at ${home}`)
  }
  await rm(workspace, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
  await rm(dbPath, { force: true })
  await rm(`${dbPath}-wal`, { force: true })
  await rm(`${dbPath}-shm`, { force: true })
}

await mkdir(stateDir, { recursive: true })
if (existsSync(home) && !existsSync(homeMarker) && (await readdir(home)).length > 0) {
  throw new Error(`refusing to use an unmarked home at ${home}`)
}
await mkdir(home, { recursive: true })
await writeFile(homeMarker, 'Synthetic screenshot home. No personal files.\n')
if (!existsSync(dbPath)) {
  await run(['go', 'run', './cmd/showcase-seed', '--db', dbPath, '--workspace', workspace])
} else if (!existsSync(join(workspace, '.threave-showcase'))) {
  throw new Error('showcase workspace is missing or unmarked; run bun run showcase:reset')
}
if (args.has('--seed-only')) {
  console.log(`Showcase database ready at ${dbPath}`)
  process.exit(0)
}

await run(['go', 'build', '-o', binaryPath, './cmd/app'])

// Only pass the variables the screenshot stack needs. No personal home directory,
// provider credentials, API URLs, or agent executables reach the demo server.
const baseEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: home,
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  LANG: process.env.LANG ?? 'en_US.UTF-8',
}
const unavailableAgent = '/usr/bin/false'
const backend = Bun.spawn([binaryPath, 'serve', '--db', dbPath, '--workspace', workspace], {
  cwd: repoRoot,
  env: {
    ...baseEnv,
    PORT: '18180',
    GORCHESTRA_HOST: '127.0.0.1',
    GORCHESTRA_WORKSPACE_ROOTS: workspace,
    GORCHESTRA_OPEN: 'false',
    GORCHESTRA_CODEX_BIN: unavailableAgent,
    GORCHESTRA_CLAUDE_BIN: unavailableAgent,
    GORCHESTRA_OPENCODE_BIN: unavailableAgent,
    GORCHESTRA_PI_BIN: unavailableAgent,
    THREAVE_CODEX_BIN: unavailableAgent,
    THREAVE_CLAUDE_BIN: unavailableAgent,
    THREAVE_OPENCODE_BIN: unavailableAgent,
    THREAVE_PI_BIN: unavailableAgent,
  },
  stdout: 'inherit',
  stderr: 'inherit',
})
const frontend = Bun.spawn(['./node_modules/.bin/vite', '--host', '127.0.0.1', '--port', '15273', '--strictPort'], {
  cwd: join(repoRoot, 'web'),
  env: { ...baseEnv, BACKEND_URL: 'http://127.0.0.1:18180' },
  stdout: 'inherit',
  stderr: 'inherit',
})

console.log('Screenshot site: http://127.0.0.1:15273')
console.log('This stack uses only synthetic data and listens on localhost.')

let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  backend.kill()
  frontend.kill()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
await Promise.race([backend.exited, frontend.exited])
stop()

async function run(command: string[]) {
  const child = Bun.spawn(command, { cwd: repoRoot, stdout: 'inherit', stderr: 'inherit' })
  const code = await child.exited
  if (code !== 0) throw new Error(`${command.join(' ')} exited with ${code}`)
}
