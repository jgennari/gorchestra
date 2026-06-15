import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

type Subprocess = ReturnType<typeof Bun.spawn>

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const args = new Set(Bun.argv.slice(2))
const tailnetMode = args.has('--tailnet')
const backendPort = process.env.PORT ?? '8080'
const webPort = process.env.WEB_PORT ?? '5173'
const webHost = tailnetMode ? '0.0.0.0' : '127.0.0.1'
const backendURL = process.env.BACKEND_URL ?? `http://localhost:${backendPort}`
const tmpDir = join(repoRoot, '.tmp')
const backendDB = process.env.GORCHESTRA_DB ?? join(tmpDir, 'sessions.db')
const backendWorkspace = process.env.GORCHESTRA_WORKSPACE ?? ''
const backendBinary = join(
  tmpDir,
  process.platform === 'win32' ? 'gorchestra-dev.exe' : 'gorchestra-dev',
)
const pollIntervalMs = 750
const restartDebounceMs = 250
const restartDeferMs = 2000

const ignoredDirs = new Set([
  '.git',
  '.idea',
  '.tmp',
  '.vscode',
  'bin',
  'dist',
  'node_modules',
  'web',
])

let backend: Subprocess | undefined
let frontend: Subprocess | undefined
let shutdownStarted = false
let backendRestarting = false
let restartTimer: Timer | undefined
let pollTimer: Timer | undefined
let checkingForChanges = false
let lastBackendSignature = ''
let restartDeferredLogged = false

async function main() {
  lastBackendSignature = await backendSignature()

  printStartup()
  await startBackend()
  startFrontend()
  startBackendWatcher()
  registerShutdownHooks()
}

function printStartup() {
  console.log(`[dev] mode: ${tailnetMode ? 'tailnet' : 'local'}`)
  console.log(`[dev] backend: ${backendURL}`)
  console.log(`[dev] database: ${backendDB}`)
  if (backendWorkspace) {
    console.log(`[dev] workspace: ${backendWorkspace}`)
  }
  console.log(`[dev] frontend: http://${webHost}:${webPort}`)

  if (tailnetMode) {
    void printTailnetURLs()
  }
}

async function printTailnetURLs() {
  const ip = await tailscaleIP()
  if (!ip) {
    console.log('[dev] tailscale ip unavailable; use `tailscale ip -4` to find the tailnet URL')
    return
  }

  console.log(`[dev] tailnet frontend: http://${ip}:${webPort}`)
}

async function tailscaleIP() {
  try {
    const proc = Bun.spawn(['tailscale', 'ip', '-4'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const output = await new Response(proc.stdout).text()
    const code = await proc.exited
    if (code !== 0) {
      return ''
    }

    return output.trim().split('\n')[0] ?? ''
  } catch {
    return ''
  }
}

async function startBackend() {
  try {
    await buildBackend()
  } catch (error) {
    console.error(`[backend] build failed: ${error}`)
    return
  }

  const backendArgs = [backendBinary, '--db', backendDB]
  if (backendWorkspace) {
    backendArgs.push('--workspace', backendWorkspace)
  }

  backend = Bun.spawn(backendArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: backendPort,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })

  void backend.exited.then((code) => {
    if (shutdownStarted || backendRestarting) {
      return
    }

    console.error(`[backend] exited with code ${code}; waiting for source changes`)
  })
}

async function buildBackend() {
  await mkdir(tmpDir, { recursive: true })

  const build = Bun.spawn(['go', 'build', '-o', backendBinary, './cmd/app'], {
    cwd: repoRoot,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await build.exited

  if (code !== 0) {
    throw new Error(`go build exited with code ${code}`)
  }
}

function startFrontend() {
  frontend = Bun.spawn(
    ['bun', 'run', 'dev', '--', '--host', webHost, '--port', webPort, '--strictPort'],
    {
      cwd: join(repoRoot, 'web'),
      env: {
        ...process.env,
        BACKEND_URL: backendURL,
      },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  )

  void frontend.exited.then((code) => {
    if (shutdownStarted) {
      return
    }

    console.error(`[frontend] exited with code ${code}`)
    void shutdown(code === 0 ? 0 : 1)
  })
}

function startBackendWatcher() {
  pollTimer = setInterval(() => {
    if (checkingForChanges || shutdownStarted) {
      return
    }

    checkingForChanges = true
    void backendSignature()
      .then((nextSignature) => {
        if (nextSignature !== lastBackendSignature) {
          lastBackendSignature = nextSignature
          scheduleBackendRestart()
        }
      })
      .catch((error) => {
        console.error(`[backend] watcher failed: ${error}`)
      })
      .finally(() => {
        checkingForChanges = false
      })
  }, pollIntervalMs)
}

function scheduleBackendRestart() {
  if (restartTimer) {
    clearTimeout(restartTimer)
  }

  restartTimer = setTimeout(() => {
    void restartBackend()
  }, restartDebounceMs)
}

async function restartBackend() {
  if (shutdownStarted || backendRestarting) {
    return
  }

  if (await hasRunningSessions()) {
    if (!restartDeferredLogged) {
      console.log('[backend] source changed; deferring restart until active runs finish')
      restartDeferredLogged = true
    }
    restartTimer = setTimeout(() => {
      void restartBackend()
    }, restartDeferMs)
    return
  }

  backendRestarting = true
  console.log(restartDeferredLogged ? '[backend] active runs finished; restarting after source change' : '[backend] restarting after source change')
  restartDeferredLogged = false

  await stopProcess(backend)
  await startBackend()
  backendRestarting = false
}

async function hasRunningSessions() {
  try {
    const response = await fetch(`${backendURL}/api/sessions?limit=1&status=running`, {
      signal: AbortSignal.timeout(1000),
    })
    if (!response.ok) {
      return false
    }
    const payload = (await response.json()) as { sessions?: unknown[] }
    return Array.isArray(payload.sessions) && payload.sessions.length > 0
  } catch {
    return false
  }
}

async function backendSignature() {
  const files = await backendFiles(repoRoot)
  const entries = await Promise.all(
    files.map(async (file) => {
      const info = await stat(file)
      return `${relative(repoRoot, file)}:${info.size}:${info.mtimeMs}`
    }),
  )

  return entries.sort().join('\n')
}

async function backendFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)

      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) {
          return []
        }

        return backendFiles(path)
      }

      if (!entry.isFile()) {
        return []
      }

      if (extname(entry.name) === '.go' || basename(entry.name).startsWith('go.')) {
        return [path]
      }

      return []
    }),
  )

  return files.flat()
}

async function stopProcess(proc: Subprocess | undefined) {
  if (!proc) {
    return
  }

  proc.kill('SIGTERM')
  await proc.exited.catch(() => undefined)
}

function registerShutdownHooks() {
  process.on('SIGINT', () => {
    void shutdown(0)
  })
  process.on('SIGTERM', () => {
    void shutdown(0)
  })
}

async function shutdown(code: number) {
  if (shutdownStarted) {
    return
  }

  shutdownStarted = true

  if (pollTimer) {
    clearInterval(pollTimer)
  }
  if (restartTimer) {
    clearTimeout(restartTimer)
  }

  await Promise.all([stopProcess(backend), stopProcess(frontend)])
  process.exit(code)
}

void main().catch((error) => {
  console.error(`[dev] failed to start: ${error}`)
  process.exit(1)
})
