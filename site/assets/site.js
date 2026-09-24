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

document.querySelectorAll('[data-tour-toggle]').forEach((button) => {
  const video = button.parentElement?.querySelector('video')
  if (!video) return
  const setLabel = (label, action) => {
    button.innerHTML = `<span aria-hidden="true">${action === 'play' ? '▶' : 'Ⅱ'}</span> ${label}`
    button.setAttribute('aria-label', label)
  }
  button.addEventListener('click', async () => {
    if (!video.paused) {
      video.pause()
      setLabel('Resume product tour', 'play')
      return
    }
    try {
      if (video.ended) video.currentTime = 0
      await video.play()
      setLabel('Pause product tour', 'pause')
    } catch {
      setLabel('Play product tour', 'play')
    }
  })
  video.addEventListener('ended', () => setLabel('Replay product tour', 'play'))
})
