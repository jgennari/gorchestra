import { useEffect, useMemo, useState } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const storageKey = 'gorchestra.theme'

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(() => storedThemePreference())
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => readSystemTheme())
  const resolvedTheme = preference === 'system' ? systemTheme : preference

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = () => setSystemTheme(query.matches ? 'dark' : 'light')

    handleChange()
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    document.documentElement.style.colorScheme = resolvedTheme
  }, [resolvedTheme])

  useEffect(() => {
    window.localStorage.setItem(storageKey, preference)
  }, [preference])

  return useMemo(
    () => ({
      preference,
      resolvedTheme,
      setPreference,
      nextPreference: () => setPreference(nextThemePreference(preference)),
    }),
    [preference, resolvedTheme],
  )
}

function storedThemePreference(): ThemePreference {
  if (typeof window === 'undefined') {
    return 'system'
  }

  const value = window.localStorage.getItem(storageKey)
  return isThemePreference(value) ? value : 'system'
}

function readSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') {
    return 'light'
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function nextThemePreference(preference: ThemePreference): ThemePreference {
  if (preference === 'system') return 'light'
  if (preference === 'light') return 'dark'
  return 'system'
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}
