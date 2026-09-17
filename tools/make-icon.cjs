// Draws the app icon from SVG and writes assets/icon.png (1024), assets/icon-256.png and assets/icon.ico.
// Run with Electron because it has a real renderer:  npx electron tools/make-icon.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d2029"/><stop offset="1" stop-color="#0f1116"/></linearGradient>
    <linearGradient id="lit" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d2fb72"/><stop offset="1" stop-color="#a5e22e"/></linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="38"/></filter>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="212" fill="url(#tile)"/>
  <rect x="66" y="66" width="892" height="892" rx="210" fill="none" stroke="#ffffff" stroke-opacity=".07" stroke-width="4"/>
  <rect x="238" y="238" width="246" height="246" rx="68" fill="#333949"/>
  <rect x="540" y="238" width="246" height="246" rx="68" fill="#333949"/>
  <rect x="238" y="540" width="246" height="246" rx="68" fill="#333949"/>
  <rect x="540" y="540" width="246" height="246" rx="68" fill="#b9f24a" opacity=".55" filter="url(#glow)" transform="rotate(12 663 663)"/>
  <rect x="540" y="540" width="246" height="246" rx="68" fill="url(#lit)" transform="rotate(12 663 663)"/>
</svg>`

function icoFromImage(image, sizes) {
  const entries = sizes.map((size) => {
    const scaled = image.resize({ width: size, height: size, quality: 'best' })
    if (size >= 256) return { size, data: scaled.toPNG() }
    const bgra = scaled.toBitmap() // BGRA, top-down
    const maskStride = Math.ceil(size / 32) * 4
    const data = Buffer.alloc(40 + size * size * 4 + maskStride * size)
    data.writeUInt32LE(40, 0)
    data.writeInt32LE(size, 4)
    data.writeInt32LE(size * 2, 8)
    data.writeUInt16LE(1, 12)
    data.writeUInt16LE(32, 14)
    data.writeUInt32LE(size * size * 4 + maskStride * size, 20)
    for (let y = 0; y < size; y++) bgra.copy(data, 40 + (size - 1 - y) * size * 4, y * size * 4, (y + 1) * size * 4)
    return { size, data }
  })
  const header = Buffer.alloc(6 + 16 * entries.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  entries.forEach((e, i) => {
    const at = 6 + i * 16
    header[at] = e.size >= 256 ? 0 : e.size
    header[at + 1] = e.size >= 256 ? 0 : e.size
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(e.data.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += e.data.length
  })
  return Buffer.concat([header, ...entries.map((e) => e.data)])
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } })
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${SVG}</body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 500))
  let image = await win.webContents.capturePage()
  if (image.getSize().width !== 1024) image = image.resize({ width: 1024, height: 1024, quality: 'best' })
  const out = path.join(__dirname, '..', 'assets')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'icon.png'), image.toPNG())
  fs.writeFileSync(path.join(out, 'icon-256.png'), image.resize({ width: 256, height: 256, quality: 'best' }).toPNG())
  fs.writeFileSync(path.join(out, 'icon.ico'), icoFromImage(image, [16, 24, 32, 48, 64, 128, 256]))
  console.log('wrote assets/icon.png, icon-256.png, icon.ico')
  app.exit(0)
})
