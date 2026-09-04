import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { basename, extname, join, relative } from 'node:path'
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
  await run(['bun', 'run', 'build'], webDir, { VITE_GORCHESTRA_VERSION: version })
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
  const compressed = await precompressHashedAssets(join(embedDist, 'assets'))
  console.log(`[build] staged ${relative(repoRoot, webDist)} -> ${relative(repoRoot, embedDist)}`)
  console.log(`[build] precompressed ${compressed} hashed frontend assets`)
}

async function precompressHashedAssets(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  let compressedCount = 0
  for (const entry of entries) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) {
      compressedCount += await precompressHashedAssets(file)
      continue
    }
    if (!entry.isFile() || !compressibleAssetExtensions.has(extname(entry.name))) {
      continue
    }
    const content = await readFile(file)
    const compressed = gzipSync(content, { level: 9 })
    if (compressed.byteLength >= content.byteLength) {
      continue
    }
    await writeFile(`${file}.gz`, compressed)
    compressedCount += 1
  }
  return compressedCount
}

const compressibleAssetExtensions = new Set(['.css', '.js', '.json', '.svg', '.wasm'])

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

async function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  console.log(`[build] ${args.join(' ')}`)
  const proc = Bun.spawn(args, {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
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
