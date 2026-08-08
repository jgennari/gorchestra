export type ReleaseUpdate = {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  releaseURL: string | null
  checkedAt: string | null
}

type GitHubRelease = {
  tag_name?: unknown
  html_url?: unknown
}

type CachedRelease = {
  latestVersion: string
  releaseURL: string
  checkedAt: string
}

const releaseEndpoint = 'https://api.github.com/repos/jgennari/gorchestra/releases/latest'
const releasePage = 'https://github.com/jgennari/gorchestra/releases'
const cacheKey = 'gorchestra.release-check.v1'
const cacheLifetime = 6 * 60 * 60 * 1000

export const gorchestraVersion = normalizeVersion(import.meta.env.VITE_GORCHESTRA_VERSION ?? 'dev')

export function isReleaseBuild(version = gorchestraVersion) {
  return parseVersion(version) !== null
}

export function emptyReleaseUpdate(currentVersion = gorchestraVersion): ReleaseUpdate {
  return {
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    releaseURL: null,
    checkedAt: null,
  }
}

export async function checkForReleaseUpdate({
  currentVersion = gorchestraVersion,
  fetcher = fetch,
  storage = window.localStorage,
  now = new Date(),
}: {
  currentVersion?: string
  fetcher?: typeof fetch
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  now?: Date
} = {}): Promise<ReleaseUpdate> {
  const normalizedCurrent = normalizeVersion(currentVersion)
  if (!isReleaseBuild(normalizedCurrent)) {
    return emptyReleaseUpdate(normalizedCurrent)
  }

  const cached = readCachedRelease(storage)
  if (cached && now.getTime() - new Date(cached.checkedAt).getTime() < cacheLifetime) {
    return releaseUpdate(normalizedCurrent, cached)
  }

  const response = await fetcher(releaseEndpoint, {
    headers: {
      Accept: 'application/vnd.github+json',
    },
  })
  if (!response.ok) {
    throw new Error(`release check failed with HTTP ${response.status}`)
  }

  const payload = (await response.json()) as GitHubRelease
  if (typeof payload.tag_name !== 'string') {
    throw new Error('release check returned an invalid tag')
  }

  const latestVersion = normalizeVersion(payload.tag_name)
  if (!parseVersion(latestVersion)) {
    throw new Error('release check returned an invalid version')
  }

  const cachedRelease: CachedRelease = {
    latestVersion,
    releaseURL: typeof payload.html_url === 'string' ? payload.html_url : releasePage,
    checkedAt: now.toISOString(),
  }
  storage.setItem(cacheKey, JSON.stringify(cachedRelease))
  return releaseUpdate(normalizedCurrent, cachedRelease)
}

export function isNewerVersion(candidate: string, current: string) {
  const candidateParts = parseVersion(candidate)
  const currentParts = parseVersion(current)
  if (!candidateParts || !currentParts) {
    return false
  }

  for (let index = 0; index < 3; index += 1) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index]
    }
  }
  return false
}

function releaseUpdate(currentVersion: string, release: CachedRelease): ReleaseUpdate {
  return {
    currentVersion,
    latestVersion: release.latestVersion,
    updateAvailable: isNewerVersion(release.latestVersion, currentVersion),
    releaseURL: release.releaseURL,
    checkedAt: release.checkedAt,
  }
}

function readCachedRelease(storage: Pick<Storage, 'getItem'>): CachedRelease | null {
  try {
    const raw = storage.getItem(cacheKey)
    if (!raw) {
      return null
    }
    const value = JSON.parse(raw) as Partial<CachedRelease>
    if (
      typeof value.latestVersion !== 'string' ||
      typeof value.releaseURL !== 'string' ||
      typeof value.checkedAt !== 'string' ||
      Number.isNaN(new Date(value.checkedAt).getTime())
    ) {
      return null
    }
    return {
      latestVersion: normalizeVersion(value.latestVersion),
      releaseURL: value.releaseURL,
      checkedAt: value.checkedAt,
    }
  } catch {
    return null
  }
}

function normalizeVersion(version: string) {
  return version.trim().replace(/^v/i, '')
}

function parseVersion(version: string): [number, number, number] | null {
  const match = normalizeVersion(version).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!match) {
    return null
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}
