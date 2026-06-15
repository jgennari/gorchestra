import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const webDir = join(repoRoot, 'web')
const webDist = join(webDir, 'dist')
const embedDist = join(repoRoot, 'internal', 'webassets', 'dist')
const releaseDir = join(repoRoot, 'dist')
const binaryName = process.platform === 'win32' ? 'gorchestra.exe' : 'gorchestra'
const binaryPath = join(releaseDir, binaryName)
const command = Bun.argv[2] ?? 'build'
const version = process.env.VERSION ?? 'dev'

async function main() {
  switch (command) {
    case 'build':
      await build()
      break
    case 'stage':
      await stageAssets()
      break
    case 'clean':
      await clean()
      break
    case 'checksums':
      await writeChecksums()
      break
    default:
      usage()
      process.exit(1)
  }
}

async function build() {
  await run(['bun', 'install', '--frozen-lockfile'], webDir)
  await run(['bun', 'run', 'build'], webDir)
  await stageAssets()
  await run(['go', 'test', './...'], repoRoot)
  await mkdir(releaseDir, { recursive: true })
  await run(['go', 'build', '-ldflags', `-X main.version=${version}`, '-o', binaryPath, './cmd/app'], repoRoot)
  await writeChecksums()
}

async function stageAssets() {
  await rm(embedDist, { force: true, recursive: true })
  await mkdir(join(repoRoot, 'internal', 'webassets'), { recursive: true })
  await cp(webDist, embedDist, { recursive: true })
  console.log(`[build] staged ${relative(repoRoot, webDist)} -> ${relative(repoRoot, embedDist)}`)
}

async function clean() {
  await Promise.all([
    rm(releaseDir, { force: true, recursive: true }),
    rm(webDist, { force: true, recursive: true }),
  ])
  console.log('[build] removed dist/ and web/dist/')
}

async function writeChecksums() {
  const entries = await readdir(releaseDir, { withFileTypes: true }).catch(() => [])
  const files = entries
    .filter((entry) => entry.isFile() && entry.name !== 'SHA256SUMS')
    .map((entry) => join(releaseDir, entry.name))
    .sort()

  const lines = await Promise.all(
    files.map(async (file) => {
      const content = await readFile(file)
      const digest = createHash('sha256').update(content).digest('hex')
      return `${digest}  ${basename(file)}`
    }),
  )

  await mkdir(releaseDir, { recursive: true })
  await writeFile(join(releaseDir, 'SHA256SUMS'), `${lines.join('\n')}\n`)
  console.log(`[build] wrote ${relative(repoRoot, join(releaseDir, 'SHA256SUMS'))}`)
}

async function run(args: string[], cwd: string) {
  console.log(`[build] ${args.join(' ')}`)
  const proc = Bun.spawn(args, {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`${args.join(' ')} exited with code ${code}`)
  }
}

function usage() {
  console.log(`Usage: bun run scripts/build.ts <command>

Commands:
  build      Install frontend deps, build/stage assets, test, build binary, write checksums
  stage      Copy web/dist into internal/webassets/dist
  clean      Remove local release output
  checksums  Write dist/SHA256SUMS for release artifacts
`)
}

main().catch((error) => {
  console.error(`[build] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
