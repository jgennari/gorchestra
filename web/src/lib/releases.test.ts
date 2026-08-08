import { checkForReleaseUpdate, isNewerVersion } from '@/lib/releases'

test('compares semantic release versions numerically', () => {
  expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true)
  expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false)
  expect(isNewerVersion('0.9.9', '0.10.0')).toBe(false)
  expect(isNewerVersion('not-a-version', '0.10.0')).toBe(false)
})

test('development builds do not make a release request', async () => {
  const fetcher = vi.fn<typeof fetch>()

  await expect(checkForReleaseUpdate({ currentVersion: 'dev', fetcher })).resolves.toMatchObject({
    currentVersion: 'dev',
    updateAvailable: false,
  })
  expect(fetcher).not.toHaveBeenCalled()
})

test('reports a newer GitHub release and caches it', async () => {
  const storage = memoryStorage()
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        tag_name: 'v0.3.0',
        html_url: 'https://github.com/jgennari/gorchestra/releases/tag/v0.3.0',
      }),
      { status: 200 },
    ),
  )
  const now = new Date('2026-07-30T16:00:00Z')

  const first = await checkForReleaseUpdate({
    currentVersion: '0.2.8',
    fetcher,
    storage,
    now,
  })
  const cached = await checkForReleaseUpdate({
    currentVersion: '0.2.8',
    fetcher,
    storage,
    now: new Date('2026-07-30T17:00:00Z'),
  })

  expect(first).toMatchObject({
    currentVersion: '0.2.8',
    latestVersion: '0.3.0',
    updateAvailable: true,
  })
  expect(cached).toEqual(first)
  expect(fetcher).toHaveBeenCalledOnce()
})

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
}
