import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const releaseDir = join(repoRoot, 'dist')
const workDir = join(releaseDir, '.release-work')
const version = normalizeVersion(process.env.VERSION ?? Bun.argv[2] ?? '')

type Target = {
  goos: string
  goarch: string
  archive: 'tar.gz' | 'zip'
}

const targets = [
  { goos: 'darwin', goarch: 'arm64', archive: 'tar.gz' },
  { goos: 'darwin', goarch: 'amd64', archive: 'tar.gz' },
  { goos: 'linux', goarch: 'arm64', archive: 'tar.gz' },
  { goos: 'linux', goarch: 'amd64', archive: 'tar.gz' },
  { goos: 'windows', goarch: 'arm64', archive: 'zip' },
  { goos: 'windows', goarch: 'amd64', archive: 'zip' },
] satisfies Target[]

async function main() {
  if (!version) {
    throw new Error('VERSION is required, for example VERSION=0.1.0 bun run release:archives')
  }

  await rm(releaseDir, { force: true, recursive: true })
  await mkdir(workDir, { recursive: true })

  for (const target of targets) {
    await buildTarget(target)
  }

  await rm(workDir, { force: true, recursive: true })
  await writeChecksums()
}

async function buildTarget(target: Target) {
  const { goos, goarch } = target
  const packageName = `gorchestra_${version}_${goos}_${goarch}`
  const packageDir = join(workDir, packageName)
  const binaryPath = join(packageDir, binaryName(goos))

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

  const archivePath = join(releaseDir, `${packageName}.${target.archive}`)
  if (target.archive === 'zip') {
    await run(['zip', '-qr', archivePath, '.'], {}, packageDir)
  } else {
    await run(['tar', '-C', packageDir, '-czf', archivePath, '.'])
  }
  console.log(`[release] wrote ${relative(repoRoot, archivePath)}`)
}

async function writeChecksums() {
  const entries = await readdir(releaseDir, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.tar.gz') || entry.name.endsWith('.zip')))
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

async function run(args: string[], env: Record<string, string> = {}, cwd = repoRoot) {
  console.log(`[release] ${args.join(' ')}`)
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

function normalizeVersion(value: string) {
  return value.trim().replace(/^v/, '')
}

function binaryName(goos: string) {
  return goos === 'windows' ? 'gorchestra.exe' : 'gorchestra'
}

main().catch((error) => {
  console.error(`[release] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
