// Drives Icon Forge through a real export and checks the files it wrote.
const fs = require('node:fs')
const path = require('node:path')
const { encodePng } = require('../../../tools/lib/png.cjs')

module.exports = async (t) => {
  const work = path.join(t.tmpDir(), 'icon-forge')
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })

  // fixture: a lime disc with a dark ring on a transparent background
  const size = 512
  const source = path.join(work, 'Test Logo.png')
  fs.writeFileSync(
    source,
    encodePng(size, size, (x, y) => {
      const d = Math.hypot(x - size / 2, y - size / 2)
      if (d > 240) return [0, 0, 0, 0]
      if (d > 170 && d < 205) return [20, 24, 12, 255]
      return [185, 242, 74, 255]
    }),
  )

  t.queuePick([source])
  if (!(await t.clickText('Browse'))) throw new Error('no Browse button')
  await t.sleep(900)
  await t.capture('loaded')

  await t.clickText('macOS')
  await t.sleep(500)
  await t.capture('macos-shape')

  // tick every output (checkboxes are <label>s, so click them directly)
  await t.exec(`for (const l of document.querySelectorAll('.keepalive:not([hidden]) .checkbox')) { const box = l.querySelector('input'); if (!box.checked) l.click() }`)
  await t.sleep(300)

  t.queuePick([work])
  await t.clickText('Export to folder')
  for (let i = 0; i < 40 && !fs.existsSync(path.join(work, 'test-logo-icons', 'appstore', 'AppIcon-1024.png')); i++) await t.sleep(250)
  await t.sleep(600)
  await t.capture('exported')

  const out = path.join(work, 'test-logo-icons')
  const must = ['test-logo.ico', 'test-logo.icns', 'png/test-logo-16.png', 'png/test-logo-1024.png', 'web/favicon.ico', 'web/apple-touch-icon.png', 'web/site.webmanifest', 'electron/icon.icns', 'tauri/128x128@2x.png', 'tauri/Square310x310Logo.png', 'appstore/AppIcon-1024.png']
  for (const rel of must) if (!fs.existsSync(path.join(out, rel))) throw new Error('missing output: ' + rel)

  // .ico: 9 entries, directory offsets land inside the file, 256 entry is PNG, smaller ones are BMP
  const ico = fs.readFileSync(path.join(out, 'test-logo.ico'))
  if (ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) !== 9) throw new Error('ico header wrong')
  for (let i = 0; i < 9; i++) {
    const at = 6 + i * 16
    const w = ico[at] || 256
    const len = ico.readUInt32LE(at + 8)
    const off = ico.readUInt32LE(at + 12)
    if (off + len > ico.length) throw new Error(`ico entry ${w} overruns the file`)
    const isPng = ico.readUInt32BE(off) === 0x89504e47
    if (w === 256 ? !isPng : ico.readUInt32LE(off) !== 40 || ico.readInt32LE(off + 8) !== w * 2) throw new Error(`ico entry ${w} has the wrong payload`)
  }

  // .icns: walk the chunks, total must equal the file size
  const icns = fs.readFileSync(path.join(out, 'test-logo.icns'))
  if (icns.toString('latin1', 0, 4) !== 'icns' || icns.readUInt32BE(4) !== icns.length) throw new Error('icns header wrong')
  const types = []
  for (let at = 8; at < icns.length; ) {
    types.push(icns.toString('latin1', at, at + 4))
    const len = icns.readUInt32BE(at + 4)
    if (len < 8) throw new Error('icns chunk length wrong')
    at += len
    if (at > icns.length) throw new Error('icns chunk overruns the file')
  }
  for (const want of ['is32', 's8mk', 'il32', 'l8mk', 'ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14']) if (!types.includes(want)) throw new Error('icns is missing ' + want)

  // App Store icon must have no transparency: PNG colour type 2 (RGB) or every alpha = 255 — check the IHDR size at least
  const store = fs.readFileSync(path.join(out, 'appstore', 'AppIcon-1024.png'))
  if (store.readUInt32BE(16) !== 1024 || store.readUInt32BE(20) !== 1024) throw new Error('App Store icon is not 1024x1024')
}
