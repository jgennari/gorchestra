import { readFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const webDir = join(repoRoot, 'web')
const embeddedIndex = join(repoRoot, 'internal', 'webassets', 'dist', 'index.html')
const watcherNudge = join(repoRoot, 'internal', 'webassets', 'assets.go')
const backendURL = process.env.GORCHESTRA_HUMAN_BACKEND_URL ?? 'http://127.0.0.1:18080'
const productionURL = process.env.GORCHESTRA_PRODUCTION_URL ?? 'https://gorchestra.coin-triceratops.ts.net'
const launchAgentLabel = process.env.GORCHESTRA_HUMAN_LAUNCH_AGENT ?? 'com.joey.gorchestra-human'
const launchDomain = `gui/${typeof process.getuid === 'function' ? process.getuid() : 501}`
const promotionTimeoutMs = parseTimeout(process.env.GORCHESTRA_PROD_REFRESH_TIMEOUT_MS)

async function main() {
  if (Bun.argv.includes('--help') || Bun.argv.includes('-h')) {
    usage()
    return
  }

  await requireHumanStack()

  console.log('[prod-refresh] building the Vite production frontend')
  await run(['bun', 'install', '--frozen-lockfile'], webDir)
  await run(['bun', 'run', 'build'], webDir, {
    VITE_GORCHESTRA_VERSION: process.env.VERSION ?? 'dev',
  })
  await run(['bun', 'run', 'build:stage'], repoRoot)

  const expectedIndex = await readFile(embeddedIndex, 'utf8')
  if (await backendServes(expectedIndex)) {
    console.log('[prod-refresh] production already serves this frontend build')
    await verifyProductionOrigin(expectedIndex)
    return
  }

  // The persistent dev runner watches Go inputs and safely defers backend
  // restarts while sessions are active. Updating this mtime signals that
  // existing watcher without changing tracked source content.
  const now = new Date()
  await utimes(watcherNudge, now, now)
  console.log('[prod-refresh] staged embedded assets and signaled the backend watcher')

  if (await hasRunningSessions()) {
    console.log('[prod-refresh] active sessions detected; production will update automatically when they finish')
    return
  }

  const result = await waitForPromotion(expectedIndex)
  if (result === 'deferred') {
    console.log('[prod-refresh] a session started; production will update automatically when active sessions finish')
    return
  }

  await verifyProductionOrigin(expectedIndex)
}

async function requireHumanStack() {
  const launchState = await runCapture(['launchctl', 'print', `${launchDomain}/${launchAgentLabel}`])
  if (launchState.exitCode !== 0) {
    fail(`the ${launchAgentLabel} LaunchAgent is not running; production was not changed`)
  }

  try {
    const response = await fetch(`${backendURL}/api/health`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) {
      fail(`human backend health returned HTTP ${response.status}; production was not changed`)
    }
  } catch (error) {
    fail(`human backend is unavailable at ${backendURL}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function hasRunningSessions() {
  try {
    const response = await fetch(`${backendURL}/api/sessions?status=running&limit=1`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) {
      return true
    }
    const payload = (await response.json()) as { sessions?: unknown[] }
    return Array.isArray(payload.sessions) && payload.sessions.length > 0
  } catch {
    return true
  }
}

async function backendServes(expectedIndex: string) {
  try {
    return (await requestText(`${backendURL}/`)) === expectedIndex
  } catch {
    return false
  }
}

async function waitForPromotion(expectedIndex: string): Promise<'updated' | 'deferred'> {
  const deadline = Date.now() + promotionTimeoutMs
  while (Date.now() < deadline) {
    if (await backendServes(expectedIndex)) {
      console.log('[prod-refresh] backend now serves the promoted frontend')
      return 'updated'
    }
    if (await hasRunningSessions()) {
      return 'deferred'
    }
    await Bun.sleep(500)
  }
  fail(`backend did not serve the promoted frontend within ${promotionTimeoutMs}ms; inspect \`bun run dev:human:logs\``)
}

async function verifyProductionOrigin(expectedIndex: string) {
  const servedIndex = await requestText(`${productionURL}/`)
  if (servedIndex !== expectedIndex) {
    fail(`${productionURL} is healthy but does not serve the promoted frontend`)
  }
  console.log(`[prod-refresh] verified ${productionURL}`)
}

async function requestText(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.text()
  } catch (fetchError) {
    const parsedURL = new URL(url)
    if (parsedURL.protocol !== 'https:' || !parsedURL.hostname.endsWith('.ts.net')) {
      throw fetchError
    }

    const dnsResult = await runCapture(['tailscale', 'dns', 'query', parsedURL.hostname])
    const serviceIP = dnsResult.stdout.match(/TypeA\s+(\d+\.\d+\.\d+\.\d+)\s*$/m)?.[1]
    if (!serviceIP) {
      throw fetchError
    }

    const curlResult = await runCapture([
      'curl',
      '-fsS',
      '--connect-timeout', '3',
      '--max-time', '8',
      '--resolve', `${parsedURL.hostname}:443:${serviceIP}`,
      url,
    ])
    if (curlResult.exitCode !== 0) {
      throw new Error(curlResult.stderr.trim() || `failed to request ${url}`)
    }
    return curlResult.stdout
  }
}

async function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  console.log(`[prod-refresh] ${args.join(' ')}`)
  const proc = Bun.spawn(args, {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    fail(`${args.join(' ')} exited with code ${exitCode}`)
  }
}

async function runCapture(args: string[]) {
  try {
    const proc = Bun.spawn(args, {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode, stdout, stderr }
  } catch (error) {
    return {
      exitCode: 127,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}

function parseTimeout(value: string | undefined) {
  if (!value) {
    return 30_000
  }
  const timeout = Number.parseInt(value, 10)
  if (!Number.isFinite(timeout) || timeout < 1000) {
    fail('GORCHESTRA_PROD_REFRESH_TIMEOUT_MS must be an integer of at least 1000')
  }
  return timeout
}

function usage() {
  console.log(`Usage: bun run prod:refresh

Build and stage the current Vite frontend for the persistent built-frontend URL.
If an agent session is running, the backend rebuild is queued until all sessions finish.`)
}

function fail(message: string): never {
  console.error(`[prod-refresh] ${message.trim()}`)
  process.exit(1)
}

void main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
