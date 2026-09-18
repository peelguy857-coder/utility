// Drives the whole thing the way Isaac would: Medium template → Publish (against a mock Netlify API
// on loopback, which checks the token and keeps the uploaded zip) → one stage moved to "a link of my
// own" → Export → the password page opened in a real window and unlocked → then the same hunt as a
// folder, where every stage is a password zip verified with Python's zipfile. Engines and the chain
// wiring are checked in-page via window.__mysteryTest.
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const TOKEN = 'nfp_test_token_0123456789abcdef'

/** A stand-in for api.netlify.com: create site, accept a zip deploy, report it ready, delete. */
function mockNetlify() {
  const state = { deploys: [], deleted: false, badAuth: 0 }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        state.badAuth++
        return json(401, { message: 'Access Denied' })
      }
      const base = `http://127.0.0.1:${server.address().port}`
      if (req.method === 'POST' && req.url === '/api/v1/sites') return json(201, { id: 'site1abc', name: 'mock-hunt', ssl_url: `${base}/live`, url: `${base}/live` })
      if (req.method === 'POST' && req.url === '/api/v1/sites/site1abc/deploys') {
        if (req.headers['content-type'] !== 'application/zip') return json(400, { message: 'expected a zip' })
        state.deploys.push(body)
        return json(200, { id: 'dep1', state: 'processing' })
      }
      if (req.method === 'GET' && req.url === '/api/v1/deploys/dep1') return json(200, { id: 'dep1', state: 'ready', ssl_url: `${base}/live` })
      if (req.method === 'DELETE' && req.url === '/api/v1/sites/site1abc') {
        state.deleted = true
        res.writeHead(204)
        return res.end()
      }
      json(404, { message: 'no such route ' + req.method + ' ' + req.url })
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, base: `http://127.0.0.1:${server.address().port}` })))
}

const py = (script, ...args) => execFileSync('python', ['-c', script, ...args], { encoding: 'utf8', timeout: 30000 }).trim()

module.exports = async (t) => {
  const outDir = path.dirname(t.shotPath('x'))
  const engines = await t.exec(`window.__mysteryTest ? window.__mysteryTest() : { skipped: true }`)
  fs.writeFileSync(path.join(outDir, 'mystery-engines.json'), JSON.stringify(engines, null, 2))
  for (const [k, v] of Object.entries(engines)) {
    if (k.endsWith('Warnings')) { if (v.length) throw new Error(`${k}: ` + v.join(' | ')); continue }
    if (v !== true) throw new Error(`engine check failed: ${k} = ${JSON.stringify(v)}`)
  }

  const work = path.join(t.tmpDir(), 'mystery')
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })
  const live = await mockNetlify()
  try {
    await t.exec(`window.__netlifyApi = ${JSON.stringify(live.base)}`)
    await t.setInput('.mm__name input', 'The Drive')
    if (!(await t.clickText('Medium'))) throw new Error('no Medium template button')
    await t.sleep(500)
    await t.capture('template')

    // ---- publish (website hunt is the default)
    await t.setInput('.keepalive:not([hidden]) .mm__publish input[type=password]', TOKEN)
    await t.sleep(500)
    if (!(await t.clickText('Publish to the internet'))) throw new Error('no Publish button')
    for (let i = 0; i < 80 && !live.state.deploys.length; i++) await t.sleep(250)
    await t.sleep(1200)
    if (!live.state.deploys.length) throw new Error('nothing was uploaded to the mock Netlify')
    if (live.state.badAuth) throw new Error('a request went out without the token')
    const shown = await t.text('.keepalive:not([hidden]) .mm__live-url')
    if (shown !== `${live.base}/live`) throw new Error('live address not shown: ' + shown)
    await t.capture('published')
    const deployZip = path.join(outDir, 'mystery-deploy.zip')
    fs.writeFileSync(deployZip, live.state.deploys[0])
    const zipReport = py(
      [
        'import zipfile,sys',
        'z = zipfile.ZipFile(sys.argv[1]); names = z.namelist()',
        'assert "index.html" in names, names',
        'assert not any(n.startswith("site/") or n == "START.txt" for n in names), names',
        'dirs = sorted({n.split("/")[0] for n in names if "/" in n})',
        'assert len(dirs) == 6, dirs',
        'gates = [n for n in names if n.endswith("index.html") and b\'type="password"\' in z.read(n)]',
        'assert len(gates) == 1, gates',
        'assert b"Go to http" not in z.read(gates[0])',
        'print("ok", len(names), " ".join(dirs))',
      ].join('\n'),
      deployZip,
    )
    if (!zipReport.startsWith('ok')) throw new Error('deploy zip: ' + zipReport)
    const walk = await t.text('.keepalive:not([hidden]) .mm__hops')
    if (!walk.includes(`Go to ${live.base}/live/`)) throw new Error('walkthrough does not use the live address')

    // ---- one stage at a link of my own
    await t.clickText('The letter')
    await t.sleep(300)
    if (!(await t.clickText('At a link of my own'))) throw new Error('no own-link option')
    await t.sleep(200)
    await t.setInput('.keepalive:not([hidden]) input[placeholder="https://…"]', 'https://pastebin.test/abc')
    await t.sleep(500)
    await t.capture('own-link')
    const walk2 = await t.text('.keepalive:not([hidden]) .mm__hops')
    if (!walk2.includes('Go to https://pastebin.test/abc')) throw new Error('the previous stage does not point at the own link')

    // ---- export the website hunt, then open its password page in a real window
    t.queuePick([work])
    if (!(await t.clickText('Export the files too'))) throw new Error('no Export button')
    const solutionPath = path.join(work, 'The Drive — SOLUTION.txt')
    for (let i = 0; i < 120 && !fs.existsSync(solutionPath); i++) await t.sleep(250)
    await t.sleep(500)
    const root = path.join(work, 'The Drive')
    const start = fs.readFileSync(path.join(root, 'START.txt'), 'utf8')
    if (!start.includes(`Go to ${live.base}/live/`)) throw new Error('START.txt has no live link: ' + start)
    for (const f of ['site/index.html', 'elsewhere/The letter.txt', 'elsewhere/PUT THESE ONLINE.txt']) if (!fs.existsSync(path.join(root, f))) throw new Error('missing ' + f)
    const siteDir = path.join(root, 'site')
    const pages = fs.readdirSync(siteDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    if (pages.length !== 5) throw new Error('expected 4 stage pages + finale (the letter is elsewhere), got ' + pages.join(','))
    const solution = fs.readFileSync(solutionPath, 'utf8')
    const gateDir = pages.find((p) => fs.readFileSync(path.join(siteDir, p, 'index.html'), 'utf8').includes('type="password"'))
    const gatePassword = /Locked[^\n]*\n[^\n]*\n[^\n]*\n\s+key:\s+password (\S+)/.exec(solution)?.[1]
    if (!gateDir || !gatePassword) throw new Error('gate page or its password not found\n' + solution)
    const { BrowserWindow } = require('electron')
    const w = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { sandbox: true } })
    try {
      await w.loadFile(path.join(siteDir, gateDir, 'index.html'))
      const wrong = await w.webContents.executeJavaScript(`(async () => { document.getElementById('p').value = 'wrong'; document.getElementById('b').click(); await new Promise(r => setTimeout(r, 1500)); return document.getElementById('bad').textContent + '|' + document.getElementById('out').textContent })()`)
      if (wrong !== 'No.|') throw new Error('gate accepted a wrong password: ' + wrong)
      const right = await w.webContents.executeJavaScript(`(async () => { document.getElementById('p').value = ${JSON.stringify(gatePassword.toLowerCase())}; document.getElementById('b').click(); await new Promise(r => setTimeout(r, 2500)); return document.getElementById('out').textContent })()`)
      if (!right.includes('Go to https://pastebin.test/abc')) throw new Error('gate did not reveal the next link: ' + right)
      const img = await w.capturePage()
      fs.writeFileSync(path.join(outDir, '21-mystery-maker--gate-page.png'), img.toPNG())
    } finally {
      w.destroy()
    }
    fs.writeFileSync(path.join(outDir, 'mystery-site.txt'), start + '\n' + pages.join('\n') + '\n\n' + solution + '\n\n' + fs.readFileSync(path.join(root, 'elsewhere/PUT THESE ONLINE.txt'), 'utf8'))

    // ---- take it down
    await t.clickText('Take it down')
    for (let i = 0; i < 40 && !live.state.deleted; i++) await t.sleep(250)
    if (!live.state.deleted) throw new Error('site was not deleted')
  } finally {
    live.server.close()
  }

  // ---- the same hunt as a folder: every stage locked behind the previous clue
  await t.clickText('Folder of files')
  await t.sleep(300)
  await t.clickText('The letter')
  await t.sleep(300)
  await t.clickText('In the folder')
  await t.sleep(500)
  await t.capture('folder-locked')
  const work3 = path.join(work, 'folder')
  fs.mkdirSync(work3, { recursive: true })
  t.queuePick([work3])
  await t.clickText('Export the hunt')
  const sol3 = path.join(work3, 'The Drive — SOLUTION.txt')
  for (let i = 0; i < 120 && !fs.existsSync(sol3); i++) await t.sleep(250)
  await t.sleep(500)
  const root3 = path.join(work3, 'The Drive')
  const start3 = fs.readFileSync(path.join(root3, 'START.txt'), 'utf8')
  if (!start3.includes('Start with "The photo.png"')) throw new Error('folder START.txt wrong: ' + start3)
  const listing = fs.readdirSync(root3).sort()
  if (listing.join(',') !== ['Locked.zip', 'START.txt', 'The photo.png', 'The recording.zip'].join(',')) throw new Error('unexpected folder contents: ' + listing.join(','))
  const solution3 = fs.readFileSync(sol3, 'utf8')
  const keys = [...solution3.matchAll(/key:\s+(?:password|keyword and zip password|keyword) (\S+)/g)].map((m) => m[1])
  if (keys.length !== 5) throw new Error('expected 5 keys (recording, zip, letter, mark, finale): ' + keys.join(','))
  const report = py(
    [
      'import zipfile, sys, io',
      'root, k_rec, k_zip, k_letter, k_mark, k_end = sys.argv[1:]',
      'def locked(z):',
      '    try:',
      '        z.read(z.namelist()[0]); return False',
      '    except RuntimeError: return True',
      'rec = zipfile.ZipFile(root + "/The recording.zip"); assert locked(rec); rec.setpassword(k_rec.encode()); assert rec.namelist() == ["The recording.wav"]; assert rec.read("The recording.wav")[:4] == b"RIFF"',
      'big = zipfile.ZipFile(root + "/Locked.zip"); assert locked(big); big.setpassword(k_zip.encode())',
      'assert sorted(big.namelist()) == sorted(["read me.txt", "The letter.zip", "The mark.zip", "the end.zip"]), big.namelist()',
      'note = big.read("read me.txt").decode(); assert \'Open "The letter.zip"\' in note and ("keyword and zip password: " + k_letter) in note, note',
      'letter = zipfile.ZipFile(io.BytesIO(big.read("The letter.zip"))); assert locked(letter); letter.setpassword(k_letter.encode()); assert letter.namelist() == ["The letter.txt"]',
      'mark = zipfile.ZipFile(io.BytesIO(big.read("The mark.zip"))); assert locked(mark); mark.setpassword(k_mark.encode()); assert mark.namelist() == ["The mark.png"]',
      'end = zipfile.ZipFile(io.BytesIO(big.read("the end.zip"))); assert locked(end); end.setpassword(k_end.encode()); assert end.namelist() == ["the end.html"]; assert b"<html" in end.read("the end.html")',
      'print("ok every stage locked")',
    ].join('\n'),
    root3,
    ...keys,
  )
  if (!report.startsWith('ok')) throw new Error('folder check: ' + report)
  fs.writeFileSync(path.join(outDir, 'mystery-folder.txt'), report + '\n\n' + start3 + '\n' + solution3)

  // ---- decode tab on our own output: the picture must name the next (locked) file and its password
  await t.clickText('Decode anything')
  await t.sleep(300)
  t.queuePick([path.join(root3, 'The photo.png')])
  await t.exec(`document.querySelectorAll('.keepalive:not([hidden]) .mm__decode .dropzone button')[0].click()`)
  await t.sleep(1200)
  const found = await t.text('.keepalive:not([hidden]) .mm__decode')
  if (!found.includes('Open "The recording.zip"') || !found.includes(`password: ${keys[0]}`)) throw new Error('decoder did not find the LSB pointer: ' + found.slice(0, 300))
  await t.setInput('.keepalive:not([hidden]) .mm__decode textarea', 'Wkh sdvvzrug lv PLGQLJKW')
  await t.sleep(400)
  const guess = await t.text('.keepalive:not([hidden]) .mm__guess.is-best')
  if (!/the password is midnight/i.test(guess)) throw new Error('best guess wrong: ' + guess)
  await t.capture('decode')
}
