// Starts sharing through the real UI, plays the phone over loopback, and screenshots both sides.
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { BrowserWindow } = require('electron')

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end(body)
  })
}

module.exports = async (t) => {
  const work = path.join(t.tmpDir(), 'phone-drop')
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })

  if (!(await t.clickText('Start sharing'))) throw new Error('no Start button')
  await t.sleep(900)
  const shown = await t.text('.phonedrop__link code')
  if (!/^127\.0\.0\.1:\d+\/[0-9a-f]{10}\/$/.test(shown)) throw new Error('unexpected link: ' + shown)
  const url = 'http://' + shown
  await t.capture('waiting')

  // PC -> phone: share a file and a link through the UI
  const note = path.join(work, 'Build 0.1.0 notes.txt')
  fs.writeFileSync(note, 'shared from the PC')
  t.queuePick([note])
  await t.clickText('Browse')
  await t.setInput('.phonedrop__compose textarea', 'https://github.com/peelguy857-coder/utility')
  await t.sleep(200)
  await t.clickText('Send')
  await t.sleep(400)

  // the phone: a real page in a phone-sized window (its EventSource counts as a connected phone)
  const phone = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  await phone.loadURL(url)
  await t.sleep(900)

  // phone -> PC: a photo-sized upload and a text
  if ((await post(url + 'upload?name=' + encodeURIComponent('IMG_2041.HEIC'), Buffer.alloc(2_400_000, 7))) !== 200) throw new Error('upload failed')
  if ((await post(url + 'text', JSON.stringify({ text: 'Wi-Fi password for the studio: correct-horse-battery' }), { 'Content-Type': 'application/json' })) !== 200) throw new Error('text failed')
  await t.sleep(900)

  const status = await phone.webContents.executeJavaScript(`document.getElementById('status').textContent`)
  if (!/^Connected to /.test(status)) throw new Error('phone page never connected: ' + status)
  const listed = await phone.webContents.executeJavaScript(`document.getElementById('files').textContent + '|' + document.getElementById('texts').textContent`)
  if (!listed.includes('Build 0.1.0 notes.txt') || !listed.includes('github.com')) throw new Error('phone page is missing shared items: ' + listed)

  phone.showInactive()
  await t.sleep(500)
  const img = await phone.capturePage()
  fs.writeFileSync(t.shotPath('phone-page'), img.toPNG())
  phone.destroy()

  const pcSide = await t.text('.keepalive:not([hidden]) .workbench__main')
  if (!pcSide.includes('IMG_2041.HEIC') || !pcSide.includes('correct-horse')) throw new Error('PC side is missing what the phone sent')
  await t.capture('after-transfer')

  await t.clickText('Stop sharing')
  await t.sleep(600)
  if (!(await t.text('.keepalive:not([hidden])')).includes('Start sharing')) throw new Error('did not return to the stopped state')
}
