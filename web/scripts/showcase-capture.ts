import { mkdir, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'

const baseURL = 'http://127.0.0.1:15273'
const output = fileURLToPath(new URL('../../.tmp/showcase/screenshots/', import.meta.url))

const health = await fetch(`${baseURL}/api/health`).catch(() => null)
if (!health?.ok) throw new Error('Start the showcase with bun run showcase, or run bun run showcase:photos')
await mkdir(output, { recursive: true })

const browser = await chromium.launch({ headless: true })
try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 })
  const page = await desktop.newPage()
  await page.goto(baseURL, { waitUntil: 'networkidle' })
  await page.screenshot({ path: `${output}overview.png`, animations: 'disabled' })

  await select(page, 'Harbor UI', 'The navigation, empty state, and dashboard now read as one flow.')
  await page.screenshot({ path: `${output}harbor-ui.png`, animations: 'disabled' })

  await select(page, 'Lantern API', 'A stale cursor returns a 400')
  await page.screenshot({ path: `${output}lantern-api.png`, animations: 'disabled' })
  await desktop.close()

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })
  const mobilePage = await mobile.newPage()
  await mobilePage.goto(baseURL, { waitUntil: 'networkidle' })
  await mobilePage.getByRole('button', { name: 'Open sessions' }).click()
  await select(mobilePage, 'Harbor UI', 'The navigation, empty state, and dashboard now read as one flow.')
  await mobilePage.screenshot({ path: `${output}harbor-ui-mobile.png`, animations: 'disabled' })
  await mobile.close()

  const tour = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
    recordVideo: { dir: output, size: { width: 1440, height: 960 } },
  })
  const tourPage = await tour.newPage()
  await tourPage.goto(baseURL, { waitUntil: 'networkidle' })
  await tourPage.waitForTimeout(1200)
  await select(tourPage, 'Harbor UI', 'The navigation, empty state, and dashboard now read as one flow.')
  await tourPage.waitForTimeout(2000)
  await select(tourPage, 'Responsive navigation', 'The active section remains visible')
  await tourPage.waitForTimeout(1800)
  await select(tourPage, 'Harbor UI', 'The navigation, empty state, and dashboard now read as one flow.')
  await tourPage.getByRole('button', { name: 'cd harbor-ui && bun run test && bun run build' }).click()
  await tourPage.waitForTimeout(2200)
  const recording = tourPage.video()
  await tour.close()
  if (!recording) throw new Error('Playwright did not record the synthetic tour')
  await recording.saveAs(`${output}tour.webm`)
  await recording.delete()
  const conversion = Bun.spawn(['ffmpeg', '-y', '-loglevel', 'error', '-i', `${output}tour.webm`,
    '-an', '-c:v', 'libx264', '-crf', '29', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${output}tour.mp4`],
    { stdout: 'inherit', stderr: 'inherit' })
  if (await conversion.exited !== 0) throw new Error('Could not convert showcase tour to MP4')
  await unlink(`${output}tour.webm`)
  console.log(`Saved four synthetic showcase screenshots and tour to ${output}`)
} finally {
  await browser.close()
}

async function select(page: Page, session: string, expectedText: string) {
  await page.getByRole('button', { name: session, exact: true }).click()
  await page.getByText(expectedText, { exact: false }).waitFor()
}
