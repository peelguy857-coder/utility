// node utilities/phone-drop/test/selftest.cjs — exercises the LAN server the way a phone would.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { DropServer, safeName } = require('../lib/server.cjs')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`)
  if (!ok) failures++
}

function request(port, method, urlPath, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-drop-test-'))
  const receiveDir = path.join(work, 'received')
  const server = new DropServer({ receiveDir, pcName: 'TEST-PC', port: 0, host: '127.0.0.1' })
  const info = await server.start()
  const { port, token } = info
  const base = `/${token}/`

  check('starts on a port and reports a URL', port > 0 && info.urls.every((u) => u.endsWith(base)))

  // ---- the secret link is the only way in
  check('no token -> 404', (await request(port, 'GET', '/')).status === 404)
  check('wrong token -> 404', (await request(port, 'GET', '/0000000000/')).status === 404)
  check('wrong token cannot upload', (await request(port, 'POST', '/nope/upload?name=x.txt', { body: 'x' })).status === 404)
  const page = await request(port, 'GET', base)
  check('page loads with a strict CSP', page.status === 200 && /Phone Drop/.test(page.body.toString()) && /default-src 'none'/.test(page.headers['content-security-policy'] || ''))
  check('page shows the PC name', page.body.toString().includes('TEST-PC'))
  check('missing trailing slash redirects', (await request(port, 'GET', `/${token}`)).status === 302)

  // ---- phone -> PC
  const big = crypto.randomBytes(3 * 1024 * 1024 + 123)
  const progress = []
  server.on('upload-progress', (p) => progress.push(p))
  const up = await request(port, 'POST', `${base}upload?name=${encodeURIComponent('holiday photo.jpg')}`, { body: big, headers: { 'Content-Length': big.length } })
  const saved = path.join(receiveDir, 'holiday photo.jpg')
  check('upload is stored byte-for-byte', up.status === 200 && fs.existsSync(saved) && fs.readFileSync(saved).equals(big))
  check('upload reports progress and completion', progress.some((p) => p.done) && progress.at(-1).received === big.length)
  check('no .part file is left behind', !fs.readdirSync(receiveDir).some((f) => f.endsWith('.part')))

  await request(port, 'POST', `${base}upload?name=${encodeURIComponent('holiday photo.jpg')}`, { body: 'second' })
  check('same name does not overwrite', fs.existsSync(path.join(receiveDir, 'holiday photo (2).jpg')) && fs.readFileSync(saved).equals(big))

  await request(port, 'POST', `${base}upload?name=${encodeURIComponent('..\\..\\evil.txt')}`, { body: 'x' })
  await request(port, 'POST', `${base}upload?name=${encodeURIComponent('../../evil2.txt')}`, { body: 'x' })
  const escaped = fs.existsSync(path.join(work, 'evil.txt')) || fs.existsSync(path.join(work, '..', 'evil.txt')) || fs.existsSync(path.join(work, 'evil2.txt'))
  check('path traversal in the name stays inside the folder', !escaped && fs.readdirSync(receiveDir).length === 4, fs.readdirSync(receiveDir).join(', '))
  check('reserved and empty names are made safe', safeName('CON.txt') === '_CON.txt' && safeName('') === 'file' && safeName('a<b>:c?.png') === 'a_b__c_.png' && safeName('trailing.. ') === 'trailing')

  // an upload that dies half-way must not leave anything
  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `${base}upload?name=broken.bin`, headers: { 'Content-Length': 1000 } })
    req.on('error', () => {})
    req.write(Buffer.alloc(100))
    setTimeout(() => {
      req.destroy()
      setTimeout(resolve, 300)
    }, 150)
  })
  check('aborted upload leaves no file', !fs.readdirSync(receiveDir).some((f) => f.startsWith('broken')))

  // ---- PC -> phone
  const sharedFile = path.join(work, 'build notes ü.txt')
  fs.writeFileSync(sharedFile, 'hello from the pc, 0123456789')
  const item = server.shareFile(sharedFile)
  const state = JSON.parse((await request(port, 'GET', `${base}api/state`)).body.toString())
  check('shared file is listed without its local path', state.files.length === 1 && state.files[0].name === 'build notes ü.txt' && !JSON.stringify(state).includes(work.replace(/\\/g, '\\\\')))
  const down = await request(port, 'GET', `${base}file/${item.id}`)
  check('download returns the file as an attachment', down.status === 200 && down.body.toString() === 'hello from the pc, 0123456789' && /attachment/.test(down.headers['content-disposition']))
  const ranged = await request(port, 'GET', `${base}file/${item.id}`, { headers: { Range: 'bytes=6-9' } })
  check('range requests work', ranged.status === 206 && ranged.body.toString() === 'from' && ranged.headers['content-range'] === 'bytes 6-9/29')
  const tail = await request(port, 'GET', `${base}file/${item.id}`, { headers: { Range: 'bytes=-4' } })
  check('suffix range works', tail.status === 206 && tail.body.toString() === '6789')
  check('bad range -> 416', (await request(port, 'GET', `${base}file/${item.id}`, { headers: { Range: 'bytes=500-600' } })).status === 416)
  check('unknown file id -> 404', (await request(port, 'GET', `${base}file/ffffffffffff`)).status === 404)
  let refused = false
  try {
    server.shareFile(work)
  } catch {
    refused = true
  }
  check('folders cannot be shared', refused)

  // ---- live updates + text both ways
  const events = []
  const sse = http.get({ host: '127.0.0.1', port, path: `${base}api/events` }, (res) => res.on('data', (c) => events.push(c.toString())))
  await new Promise((r) => setTimeout(r, 200))
  check('phone page connection is counted', server.info().phones === 1)
  server.addText('https://example.com/from-pc', 'pc')
  let fromPhone = null
  server.on('text', (t) => (fromPhone = t))
  const sent = await request(port, 'POST', `${base}text`, { body: JSON.stringify({ text: 'note from phone' }), headers: { 'Content-Type': 'application/json' } })
  await new Promise((r) => setTimeout(r, 200))
  check('text from the phone reaches the PC', sent.status === 200 && fromPhone && fromPhone.text === 'note from phone' && fromPhone.from === 'phone')
  check('text from the PC is pushed to the phone live', events.join('').includes('from-pc'))
  check('garbage text body -> 400', (await request(port, 'POST', `${base}text`, { body: '{nope' })).status === 400)
  check('empty text -> 400', (await request(port, 'POST', `${base}text`, { body: JSON.stringify({ text: '   ' }) })).status === 400)
  sse.destroy()

  // ---- shutdown
  await server.stop()
  let closed = false
  try {
    await request(port, 'GET', base)
  } catch {
    closed = true
  }
  check('stop() closes the port', closed)

  fs.rmSync(work, { recursive: true, force: true })
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
