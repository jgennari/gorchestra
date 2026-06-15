import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const releaseDir = join(repoRoot, 'dist')
const workDir = join(releaseDir, '.release-work')
const version = normalizeVersion(process.env.VERSION ?? Bun.argv[2] ?? '')

const targets = [
  { goos: 'darwin', goarch: 'arm64' },
  { goos: 'darwin', goarch: 'amd64' },
  { goos: 'linux', goarch: 'arm64' },
  { goos: 'linux', goarch: 'amd64' },
] as const

async function main() {
  if (!version) {
    throw new Error('VERSION is required, for example VERSION=0.1.0 bun run release:archives')
  }

  await rm(releaseDir, { force: true, recursive: true })
  await mkdir(workDir, { recursive: true })

  for (const target of targets) {
    await buildTarget(target.goos, target.goarch)
  }

  await rm(workDir, { force: true, recursive: true })
  await writeChecksums()
}

async function buildTarget(goos: string, goarch: string) {
  const packageName = `gorchestra_${version}_${goos}_${goarch}`
  const packageDir = join(workDir, packageName)
  const binaryPath = join(packageDir, 'gorchestra')

  await mkdir(packageDir, { recursive: true })
  await run(
    [
      'go',
      'build',
      '-trimpath',
      '-ldflags',
      `-s -w -X main.version=${version}`,
      '-o',
      binaryPath,
      './cmd/app',
    ],
    {
      GOOS: goos,
      GOARCH: goarch,
      CGO_ENABLED: '0',
    },
  )

  await cp(join(repoRoot, 'README.md'), join(packageDir, 'README.md'))
  await cp(join(repoRoot, 'LICENSE'), join(packageDir, 'LICENSE'))

  const archivePath = join(releaseDir, `${packageName}.tar.gz`)
  await run(['tar', '-C', packageDir, '-czf', archivePath, '.'])
  console.log(`[release] wrote ${relative(repoRoot, archivePath)}`)
}

async function writeChecksums() {
  const entries = await readdir(releaseDir, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tar.gz'))
    .map((entry) => join(releaseDir, entry.name))
    .sort()

  const lines = await Promise.all(
    files.map(async (file) => {
      const content = await readFile(file)
      const digest = createHash('sha256').update(content).digest('hex')
      return `${digest}  ${basename(file)}`
    }),
  )

  await writeFile(join(releaseDir, 'SHA256SUMS'), `${lines.join('\n')}\n`)
  console.log(`[release] wrote ${relative(repoRoot, join(releaseDir, 'SHA256SUMS'))}`)
}

async function run(args: string[], env: Record<string, string> = {}) {
  console.log(`[release] ${args.join(' ')}`)
  const proc = Bun.spawn(args, {
    cwd: repoRoot,
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

function normalizeVersion(value: string) {
  return value.trim().replace(/^v/, '')
}

main().catch((error) => {
  console.error(`[release] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
