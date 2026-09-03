import { act, renderHook } from '@testing-library/react'
import { railContentStorageKey, useRailContentPreference } from '@/hooks/use-rail-content'

beforeEach(() => {
  window.localStorage.clear()
})

test('defaults to files and persists a browser-wide selection', () => {
  const { result, unmount } = renderHook(() => useRailContentPreference())
  expect(result.current.mode).toBe('files')

  act(() => result.current.setMode('conversation-map'))
  expect(window.localStorage.getItem(railContentStorageKey)).toBe('conversation-map')
  unmount()

  const restored = renderHook(() => useRailContentPreference())
  expect(restored.result.current.mode).toBe('conversation-map')
})

test('ignores an invalid stored mode', () => {
  window.localStorage.setItem(railContentStorageKey, 'surprise')

  const { result } = renderHook(() => useRailContentPreference())

  expect(result.current.mode).toBe('files')
  expect(window.localStorage.getItem(railContentStorageKey)).toBe('files')
})

test('restores the signal field selection', () => {
  window.localStorage.setItem(railContentStorageKey, 'signal-field')

  const { result } = renderHook(() => useRailContentPreference())

  expect(result.current.mode).toBe('signal-field')
})
