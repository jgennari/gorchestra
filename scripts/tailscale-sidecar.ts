import { access, chmod, copyFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const toolRoot = join(repoRoot, 'tools', 'tailscale-sidecar')
const tmpRoot = join(repoRoot, '.tmp', 'tailscale-sidecar')
const supportRoot = join(homedir(), 'Library', 'Application Support', 'Gorchestra')
const binaryPath = join(supportRoot, 'bin', 'gorchestra-tailscale-sidecar')
const stateDir = join(supportRoot, 'tailscale-sidecar')
const logDir = join(homedir(), 'Library', 'Logs', 'Gorchestra')
const stdoutPath = join(logDir, 'tailscale-sidecar.log')
const stderrPath = join(logDir, 'tailscale-sidecar.err.log')
const label = 'com.joey.gorchestra-tailscale-sidecar'
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
const launchDomain = `gui/${typeof process.getuid === 'function' ? process.getuid() : 501}`
const launchTarget = `${launchDomain}/${label}`
const command = Bun.argv[2] ?? 'status'

async function main() {
  switch (command) {
    case 'install':
      await install()
      break
    case 'start':
      await start()
      break
    case 'stop':
      await stop()
      break
    case 'restart':
      await restart()
      break
    case 'status':
      await status()
      break
    case 'logs':
      await logs()
      break
    default:
      fail('usage: bun run tailscale:sidecar <install|start|stop|restart|status|logs>')
  }
}

async function install() {
  await Promise.all([
    mkdir(tmpRoot, { recursive: true }),
    mkdir(join(supportRoot, 'bin'), { recursive: true }),
    mkdir(stateDir, { recursive: true, mode: 0o700 }),
    mkdir(logDir, { recursive: true }),
  ])

  const stagedBinary = join(tmpRoot, 'gorchestra-tailscale-sidecar')
  const build = run(['go', 'build', '-trimpath', '-o', stagedBinary, '.'], toolRoot)
  if (build.exitCode !== 0) {
    fail(build.stderr || build.stdout || 'sidecar build failed')
  }
  const nextBinary = `${binaryPath}.new`
  await copyFile(stagedBinary, nextBinary)
  await chmod(nextBinary, 0o755)
  await rename(nextBinary, binaryPath)
  await writeFile(plistPath, launchAgentPlist())
  console.log(`[tailscale-sidecar] installed ${binaryPath}`)
  console.log(`[tailscale-sidecar] installed ${plistPath}`)

  if (launchAgentState().loaded) {
    await restart()
  } else {
    await start()
  }
}

async function start() {
  await requireInstall()
  if (launchAgentState().loaded) {
    console.log(`[tailscale-sidecar] ${label} is already loaded`)
    await status()
    return
  }
  const result = run(['launchctl', 'bootstrap', launchDomain, plistPath])
  if (result.exitCode !== 0) {
    fail(result.stderr || 'failed to bootstrap LaunchAgent')
  }
  console.log(`[tailscale-sidecar] loaded ${label}`)
  await new Promise((resolve) => setTimeout(resolve, 1000))
  await status()
}

async function stop() {
  if (!launchAgentState().loaded) {
    console.log(`[tailscale-sidecar] ${label} is not loaded`)
    return
  }
  const result = run(['launchctl', 'bootout', launchTarget])
  if (result.exitCode !== 0) {
    fail(result.stderr || 'failed to unload LaunchAgent')
  }
  console.log(`[tailscale-sidecar] unloaded ${label}`)
}

async function restart() {
  await requireInstall()
  if (!launchAgentState().loaded) {
    await start()
    return
  }
  const result = run(['launchctl', 'kickstart', '-k', launchTarget])
  if (result.exitCode !== 0) {
    fail(result.stderr || 'failed to restart LaunchAgent')
  }
  console.log(`[tailscale-sidecar] restarted ${label}`)
  await new Promise((resolve) => setTimeout(resolve, 1000))
  await status()
}

async function status() {
  const state = launchAgentState()
  const [productionStatus, developmentStatus] = await Promise.all([
    probe('https://gorchestra.coin-triceratops.ts.net/api/health'),
    probe('https://gorchestra-dev.coin-triceratops.ts.net/api/health'),
  ])
  console.log(`[tailscale-sidecar] service: ${label}`)
  console.log(`[tailscale-sidecar] state: ${state.loaded ? state.state || 'loaded' : 'stopped'}${state.pid ? ` (pid ${state.pid})` : ''}`)
  console.log(`[tailscale-sidecar] production: https://gorchestra.coin-triceratops.ts.net (${productionStatus})`)
  console.log(`[tailscale-sidecar] development: https://gorchestra-dev.coin-triceratops.ts.net (${developmentStatus})`)
  console.log(`[tailscale-sidecar] state directory: ${stateDir}`)
  console.log(`[tailscale-sidecar] logs: ${stdoutPath}, ${stderrPath}`)
}

async function logs() {
  await mkdir(logDir, { recursive: true })
  const lines = Bun.argv[3] ?? '100'
  const result = run(['tail', '-n', lines, stdoutPath, stderrPath])
  if (result.exitCode !== 0) {
    fail(result.stderr || 'failed to read sidecar logs')
  }
  process.stdout.write(result.stdout)
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

async function requireInstall() {
  try {
    await Promise.all([access(binaryPath), access(plistPath)])
  } catch {
    fail('sidecar is not installed; run `bun run tailscale:sidecar:install`')
  }
}

async function probe(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) })
    return response.ok ? 'ok' : `http ${response.status}`
  } catch {
    const parsedURL = new URL(url)
    const dnsResult = run(['tailscale', 'dns', 'query', parsedURL.hostname])
    const serviceIP = dnsResult.stdout.match(/TypeA\s+(\d+\.\d+\.\d+\.\d+)\s*$/m)?.[1]
    if (!serviceIP) {
      return 'offline'
    }

    const curlResult = run([
      'curl',
      '-fsS',
      '--connect-timeout', '3',
      '--max-time', '5',
      '--resolve', `${parsedURL.hostname}:443:${serviceIP}`,
      '-o', '/dev/null',
      '-w', '%{http_code}',
      url,
    ])
    if (curlResult.exitCode !== 0) {
      return 'offline'
    }
    const statusCode = Number.parseInt(curlResult.stdout, 10)
    return statusCode >= 200 && statusCode < 300 ? 'ok via Tailscale DNS' : `http ${statusCode}`
  }
}

function run(args: string[], cwd = repoRoot) {
  const proc = Bun.spawnSync(args, { cwd, stdout: 'pipe', stderr: 'pipe' })
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout ? new TextDecoder().decode(proc.stdout) : '',
    stderr: proc.stderr ? new TextDecoder().decode(proc.stderr) : '',
  }
}

function launchAgentPlist() {
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const argumentsList = [
    binaryPath,
    '-state-dir', stateDir,
    '-hostname', 'gorchestra-services-host',
    '-tag', 'tag:gorchestra-services',
    '-prod-service', 'svc:gorchestra',
    '-dev-service', 'svc:gorchestra-dev',
    '-prod-target', 'http://127.0.0.1:18080',
    '-dev-target', 'http://127.0.0.1:15173',
    '-api-target', 'http://127.0.0.1:18080',
  ].map((argument) => `    <string>${escape(argument)}</string>`).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsList}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escape(stderrPath)}</string>
</dict>
</plist>
`
}

function fail(message: string): never {
  console.error(`[tailscale-sidecar] ${message.trim()}`)
  process.exit(1)
}

void main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
