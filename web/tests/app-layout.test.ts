import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

const appStyles = readFileSync(resolve(import.meta.dirname, '../src/App.css'), 'utf8')
let style: HTMLStyleElement

beforeEach(() => {
  style = document.createElement('style')
  style.textContent = appStyles
  document.head.append(style)
})

afterEach(() => style.remove())

function baseStyle(selector: string) {
  const rule = Array.from(style.sheet!.cssRules).find((rule) =>
    'selectorText' in rule && (rule as CSSStyleRule).selectorText.split(',').some((part) => part.trim() === selector),
  ) as CSSStyleRule
  expect(rule).toBeDefined()
  return rule.style
}

test('the app shell stays inside the browser viewport at every width', () => {
  const shell = baseStyle('.app-shell')
  // Safari's expanded toolbar makes dvh smaller than lvh. Offsetting the
  // shell by their difference hides its header above the reachable viewport.
  // Keep controls in the viewport; safe-area spacing belongs inside it.
  expect(shell.getPropertyValue('position')).toBe('fixed')
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    expect(shell.getPropertyValue(edge)).toBe('0px')
  }
  expect(shell.getPropertyValue('height')).toBe('auto')
  expect(shell.getPropertyValue('overflow')).toBe('hidden')
})

test.each([
  ['.mobile-floating-header-shell', 'top', 'env(safe-area-inset-top, 0px)'],
  ['.dashboard-overview-content', 'padding-top', 'calc(env(safe-area-inset-top, 0px) + 1rem)'],
  ['.host-console-frame', 'padding-top', 'calc(env(safe-area-inset-top, 0px) + 5rem)'],
  ['.host-preview-body', 'padding-top', 'calc(env(safe-area-inset-top, 0px) + 5.25rem)'],
  ['.session-schedules-body', 'padding-top', 'calc(env(safe-area-inset-top, 0px) + 5.25rem)'],
  ['.session-settings-body', 'padding-top', 'calc(env(safe-area-inset-top, 0px) + 5.25rem)'],
  ['.repository-skills-body', 'padding-top', 'calc(env(safe-area-inset-top, 0px) + 5.25rem)'],
  ['.mobile-file-viewer-panel', 'top', 'calc(env(safe-area-inset-top, 0px) + 5rem)'],
])('%s uses safe-area spacing without a second browser-toolbar offset', (selector, property, expected) => {
  // jsdom drops standalone env() values and misserializes env() inside calc().
  // Check the authored declaration; real-browser checks cover its geometry.
  const selectorOffset = appStyles.indexOf(selector)
  expect(selectorOffset).toBeGreaterThanOrEqual(0)
  const body = appStyles.slice(selectorOffset).match(/^[^{]*\{([^}]*)\}/)?.[1] ?? ''
  const value = body.match(new RegExp(`\\b${property}\\s*:\\s*([^;]+);`))?.[1].trim()
  expect(value).toBe(expected)
})
