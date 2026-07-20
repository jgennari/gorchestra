export const clipboardCopyErrorMessage = 'Couldn’t copy to the clipboard. Select the text and copy it manually.'

export async function copyText(value: string): Promise<void> {
  if (typeof navigator !== 'undefined') {
    const clipboard = navigator.clipboard
    if (clipboard && typeof clipboard.writeText === 'function') {
      try {
        await clipboard.writeText(value)
        return
      } catch {
        // Fall through to the selection-based copy path. This also covers denied permissions.
      }
    }
  }

  if (copyTextWithSelection(value)) return
  throw new Error(clipboardCopyErrorMessage)
}

function copyTextWithSelection(value: string): boolean {
  if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') {
    return false
  }

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const selection = document.getSelection()
  const selectedRanges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : []
  const textarea = document.createElement('textarea')

  textarea.value = value
  textarea.readOnly = true
  textarea.setAttribute('aria-hidden', 'true')
  Object.assign(textarea.style, {
    position: 'fixed',
    left: '-9999px',
    top: '0',
    width: '1px',
    height: '1px',
    padding: '0',
    border: '0',
    opacity: '0',
    pointerEvents: 'none',
  })

  document.body.appendChild(textarea)
  let copied: boolean
  try {
    textarea.focus({ preventScroll: true })
    textarea.select()
    textarea.setSelectionRange(0, value.length)
    copied = document.execCommand('copy')
  } catch {
    copied = false
  } finally {
    textarea.remove()
    activeElement?.focus({ preventScroll: true })
    if (selection) {
      selection.removeAllRanges()
      for (const range of selectedRanges) selection.addRange(range)
    }
  }

  return copied
}
