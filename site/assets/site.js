document.querySelectorAll('[data-year]').forEach((node) => { node.textContent = String(new Date().getFullYear()) })
document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const target = document.getElementById(button.dataset.copy)
    if (!target || !navigator.clipboard) return
    await navigator.clipboard.writeText(target.textContent.trim())
    button.textContent = 'Copied'
    window.setTimeout(() => { button.textContent = 'Copy' }, 1800)
  })
})
