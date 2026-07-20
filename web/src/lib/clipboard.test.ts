import { clipboardCopyErrorMessage, copyText } from '@/lib/clipboard'

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')

afterEach(() => {
  restoreProperty(navigator, 'clipboard', originalClipboard)
  restoreProperty(document, 'execCommand', originalExecCommand)
})

test('uses the async clipboard API when it is available', async () => {
  const writeText = vi.fn(async () => undefined)
  setProperty(navigator, 'clipboard', { writeText })
  const execCommand = vi.fn(() => true)
  setProperty(document, 'execCommand', execCommand)

  await copyText('modern copy')

  expect(writeText).toHaveBeenCalledWith('modern copy')
  expect(execCommand).not.toHaveBeenCalled()
})

test('falls back to a selected textarea when the async API is unavailable', async () => {
  setProperty(navigator, 'clipboard', undefined)
  const execCommand = vi.fn(() => {
    expect(document.querySelector('textarea')?.value).toBe('fallback copy')
    return true
  })
  setProperty(document, 'execCommand', execCommand)

  await copyText('fallback copy')

  expect(execCommand).toHaveBeenCalledWith('copy')
  expect(document.querySelector('textarea')).not.toBeInTheDocument()
})

test('falls back after a denied async clipboard write', async () => {
  const writeText = vi.fn(async () => {
    throw new DOMException('Permission denied', 'NotAllowedError')
  })
  setProperty(navigator, 'clipboard', { writeText })
  const execCommand = vi.fn(() => true)
  setProperty(document, 'execCommand', execCommand)

  await copyText('permission fallback')

  expect(writeText).toHaveBeenCalledWith('permission fallback')
  expect(execCommand).toHaveBeenCalledWith('copy')
})

test('reports failure when neither clipboard path succeeds', async () => {
  setProperty(navigator, 'clipboard', undefined)
  setProperty(document, 'execCommand', vi.fn(() => false))

  await expect(copyText('uncopyable')).rejects.toThrow(clipboardCopyErrorMessage)
  expect(document.querySelector('textarea')).not.toBeInTheDocument()
})

function setProperty(target: object, key: PropertyKey, value: unknown) {
  Object.defineProperty(target, key, { configurable: true, value })
}

function restoreProperty(target: object, key: PropertyKey, descriptor?: PropertyDescriptor) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor)
  } else {
    Reflect.deleteProperty(target, key)
  }
}
