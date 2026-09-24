import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const frontendURL = 'http://127.0.0.1:15273'
const backendURL = 'http://127.0.0.1:18180'

if (await reachable(frontendURL) || await reachable(backendURL)) {
  throw new Error('Showcase ports are already in use; stop that server before running showcase:photos')
}

const server = Bun.spawn(['bun', 'run', 'showcase'], {
  cwd: repoRoot,
  stdout: 'inherit',
  stderr: 'inherit',
})
try {
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await reachable(`${frontendURL}/api/health`) && await reachable(`${backendURL}/api/health`)) {
      ready = true
      break
    }
    if (server.exitCode !== null) throw new Error(`showcase server exited with ${server.exitCode}`)
    await Bun.sleep(500)
  }
  if (!ready) throw new Error('showcase server did not become healthy')

  const capture = Bun.spawn(['bun', 'run', 'showcase:capture'], {
    cwd: repoRoot,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await capture.exited
  if (code !== 0) throw new Error(`showcase capture exited with ${code}`)
} finally {
  server.kill('SIGTERM')
  await server.exited
}

async function reachable(url: string) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(700) })).ok
  } catch {
    return false
  }
}
