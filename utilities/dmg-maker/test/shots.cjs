// Drives DMG Maker through a real build: zipped demo app in, cover picture on, drag an icon, build, verify.
const fs = require('node:fs')
const path = require('node:path')
const { demoEntries, writeZip } = require('./fixtures.cjs')
const { encodePng } = require('../../../tools/lib/png.cjs')
const { readDmg } = require('../lib/index.cjs')

module.exports = async (t) => {
  const work = path.join(t.tmpDir(), 'dmg-maker')
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })
  const zip = writeZip(path.join(work, 'Demo-mac.zip'), demoEntries({ bigBytes: 2 * 1024 * 1024 }))
  const cover = path.join(work, 'cover.png')
  fs.writeFileSync(cover, encodePng(660, 400, (x, y) => [230 - Math.floor((y / 400) * 40), 232, 225 + Math.floor((x / 660) * 30), 255]))

  t.queuePick([zip])
  if (!(await t.clickText('Browse'))) throw new Error('no Browse button')
  await t.sleep(1200)
  const summary = await t.text('.keepalive:not([hidden]) .dmg-source')
  if (!summary.includes('Demo App') || !summary.includes('1.2.3')) throw new Error('app was not recognised: ' + summary)
  await t.capture('loaded')

  // cover picture via the side panel's compact dropzone (its Browse is the second one on screen)
  t.queuePick([cover])
  await t.exec(`(() => { const zones = [...document.querySelectorAll('.keepalive:not([hidden]) .dropzone--compact button')]; zones[0]?.click() })()`)
  await t.sleep(900)
  await t.clickText('macOS') // nothing to click here: keeps the pattern; ignored if absent
  await t.setInput('.keepalive:not([hidden]) .input input', 'Demo Installer')
  await t.sleep(400)
  await t.capture('designed')

  const out = path.join(work, 'Demo Installer.dmg')
  t.queuePick([out])
  if (!(await t.clickText('Build DMG'))) throw new Error('no Build button')
  for (let i = 0; i < 120 && !fs.existsSync(out); i++) await t.sleep(250)
  for (let i = 0; i < 40 && !(await t.text('.keepalive:not([hidden])')).includes('Build again'); i++) await t.sleep(250)
  await t.capture('built')
  if (!fs.existsSync(out)) throw new Error('no DMG was written')

  const back = await readDmg(out)
  const bad = back.checks.filter((c) => !c.ok)
  if (bad.length) throw new Error('image fails its checks: ' + bad.map((c) => c.name).join(', '))
  const names = new Set(back.entries.map((e) => e.path))
  for (const want of ['Demo.app', 'Applications', '.background/background.png', '.DS_Store']) if (!names.has(want)) throw new Error('missing on the volume: ' + want)
  if (back.volume.name !== 'Demo Installer') throw new Error('volume name is ' + back.volume.name)
}
