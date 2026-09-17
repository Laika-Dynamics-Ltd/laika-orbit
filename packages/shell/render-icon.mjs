/**
 * Runs inside Electron (see make-app.mjs): renders icon.html offscreen at 1024×1024 and
 * writes it as a PNG to the path given on the command line. No image library needed;
 * Chromium is the rasteriser.
 */
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

const out = process.argv[process.argv.length - 1]
app.dock?.hide()
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  })
  win.webContents.setFrameRate(1)
  await win.loadFile(join(dirname(fileURLToPath(import.meta.url)), 'icon.html'))
  await new Promise((r) => setTimeout(r, 600))
  const img = await win.webContents.capturePage()
  await writeFile(out, img.toPNG())
  app.exit(0)
})
