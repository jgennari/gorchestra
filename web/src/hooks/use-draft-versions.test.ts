import { renderHook } from '@testing-library/react'
import { useDraftVersions } from '@/hooks/use-draft-versions'

beforeEach(() => window.localStorage.clear())

test('a stale tab cannot erase the other tab’s recoverable draft, including after remount', () => {
  const a = renderHook(({ content }) => useDraftVersions('session', content), { initialProps: { content: '' } })
  a.rerender({ content: 'draft A' })
  const b = renderHook(({ content }) => useDraftVersions('session', content), { initialProps: { content: 'draft A' } })
  b.rerender({ content: 'newer draft B' })
  expect(a.result.current.versions.map((value) => value.draft)).toContain('newer draft B')
  a.rerender({ content: 'stale draft A edited' })
  b.unmount()
  a.unmount()
  const reopened = renderHook(() => useDraftVersions('session', 'stale draft A edited'))
  expect(reopened.result.current.versions.map((value) => value.draft)).toContain('newer draft B')
})
