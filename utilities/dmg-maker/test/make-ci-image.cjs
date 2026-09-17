// node utilities/dmg-maker/test/make-ci-image.cjs [outDir]
// Builds the image that CI hands to a real Mac: zipped demo app (modes + symlinks), cover picture,
// disk icon, custom icon positions. Also writes the manifest the Mac-side script compares against.
const fs = require('node:fs')
const path = require('node:path')
const { demoEntries, writeZip } = require('./fixtures.cjs')
const { encodePng } = require('../../../tools/lib/png.cjs')
const dmg = require('../lib/index.cjs')

async function main() {
  const out = path.resolve(process.argv[2] || path.join(__dirname, 'out'))
  fs.mkdirSync(out, { recursive: true })

  const zip = writeZip(path.join(out, 'ci-demo-app.zip'), demoEntries({ caseClash: true, many: 400, bigBytes: 3 * 1024 * 1024 + 17 }))

  // cover: dark gradient with a lime arrow pointing from the app to Applications
  const W = 660
  const H = 400
  const cover = path.join(out, 'cover.png')
  fs.writeFileSync(
    cover,
    encodePng(W, H, (x, y) => {
      const onShaft = Math.abs(y - 190) < 5 && x > 270 && x < 380
      const onHead = x >= 380 && x < 410 && Math.abs(y - 190) < (410 - x) * 0.7
      if (onShaft || onHead) return [185, 242, 74, 255]
      const t = y / H
      return [Math.round(24 + 18 * t), Math.round(27 + 20 * t), Math.round(38 + 40 * t), 255]
    }),
  )

  // disk icon: one 256px PNG entry is enough for Finder
  const iconPng = encodePng(256, 256, (x, y) => (Math.hypot(x - 128, y - 128) < 118 ? [185, 242, 74, 255] : [0, 0, 0, 0]))
  const entry = Buffer.alloc(8)
  entry.write('ic08', 0, 'latin1')
  entry.writeUInt32BE(8 + iconPng.length, 4)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'latin1')
  head.writeUInt32BE(16 + iconPng.length, 4)
  const icns = path.join(out, 'disk.icns')
  fs.writeFileSync(icns, Buffer.concat([head, entry, iconPng]))

  const file = path.join(out, 'ci-demo.dmg')
  const res = await dmg.buildDmg({
    source: zip,
    outPath: file,
    volumeName: 'Utility CI Demo',
    background: cover,
    volumeIcon: icns,
    window: { x: 200, y: 120, width: W, height: H + 28 },
    iconSize: 128,
    appPosition: { x: 170, y: 190 },
    applicationsPosition: { x: 490, y: 190 },
    writeManifestHashes: true,
  })
  fs.writeFileSync(path.join(out, 'ci-demo.manifest.json'), JSON.stringify({ volumeName: res.volumeName, entries: res.manifest }, null, 1))
  console.log(`built ${file}: ${res.bytes} bytes, ${res.manifest.length} manifest entries`)
  for (const w of res.warnings) console.log('warning:', w)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
