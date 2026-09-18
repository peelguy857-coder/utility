// Loads two generated thumbnails and screenshots every view.
const fs = require('node:fs')
const path = require('node:path')
const { encodePng } = require('../../../tools/lib/png.cjs')

module.exports = async (t) => {
  const work = path.join(t.tmpDir(), 'thumb-tester')
  fs.mkdirSync(work, { recursive: true })
  const a = path.join(work, 'day100-A.png')
  const b = path.join(work, 'day100-B.png')
  fs.writeFileSync(a, encodePng(640, 360, (x, y) => (Math.hypot(x - 320, y - 180) < 110 ? [255, 210, 40, 255] : [30 + Math.floor(x / 8), 90, 160 - Math.floor(y / 4), 255])))
  fs.writeFileSync(b, encodePng(1280, 720, (x, y) => (Math.abs(x - y * 1.7) < 60 ? [185, 242, 74, 255] : [20, 22, 30, 255])))

  t.queuePick([a, b])
  if (!(await t.clickText('Browse'))) throw new Error('no Browse button')
  await t.sleep(1000)
  const checks = await t.text('.keepalive:not([hidden]) .tt-checks')
  if (!/at least 1280/.test(checks)) throw new Error('the 640×360 thumbnail was not flagged: ' + checks)
  await t.capture('home')
  for (const [label, name] of [['Search', 'search'], ['Up next', 'sidebar'], ['Phone', 'phone']]) {
    await t.clickText(label)
    await t.sleep(350)
    await t.capture(name)
  }
  await t.clickText('Home')
  await t.clickText('Light')
  await t.sleep(350)
  await t.capture('light')
}
