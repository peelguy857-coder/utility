// Builds the Medium template as a folder hunt and as a website hunt, exports both, then checks the
// chain the way a player would follow it: START.txt → picture (LSB) → recording → locked zip (real
// ZipCrypto, verified with Python's zipfile) → … → the end. Engines and the password page are
// checked in-page via window.__mysteryTest.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

module.exports = async (t) => {
  const engines = await t.exec(`window.__mysteryTest ? window.__mysteryTest() : { skipped: true }`)
  fs.writeFileSync(path.join(path.dirname(t.shotPath('x')), 'mystery-engines.json'), JSON.stringify(engines, null, 2))
  for (const [k, v] of Object.entries(engines)) {
    if (k === 'siteWarnings') { if (v.length) throw new Error('site build warned: ' + v.join(' | ')); continue }
    if (v !== true) throw new Error(`engine check failed: ${k} = ${JSON.stringify(v)}`)
  }

  const work = path.join(t.tmpDir(), 'mystery')
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })

  await t.setInput('.mm__name input', 'The Drive')
  if (!(await t.clickText('Medium'))) throw new Error('no Medium template button')
  await t.sleep(500)
  await t.capture('template')
  await t.clickText('The recording')
  await t.sleep(900)
  await t.capture('audio-stage')
  await t.clickText('The letter')
  await t.sleep(400)
  await t.capture('cipher-stage')
  if (!(await t.text('.keepalive:not([hidden]) .mm__hops')).includes('START.txt')) throw new Error('walkthrough missing')

  // ---- folder hunt
  t.queuePick([work])
  if (!(await t.clickText('Export the hunt'))) throw new Error('no Export button')
  const solutionPath = path.join(work, 'The Drive — SOLUTION.txt')
  for (let i = 0; i < 120 && !fs.existsSync(solutionPath); i++) await t.sleep(250)
  await t.sleep(500)
  await t.capture('exported')
  const root = path.join(work, 'The Drive')
  const solution = fs.readFileSync(solutionPath, 'utf8')
  const start = fs.readFileSync(path.join(root, 'START.txt'), 'utf8')
  if (!start.includes('Start with "The photo.png"')) throw new Error('START.txt does not point at the first stage: ' + start)
  for (const f of ['The photo.png', 'The recording.wav', 'Locked.zip']) if (!fs.existsSync(path.join(root, f))) throw new Error('missing output ' + f)
  if (fs.existsSync(path.join(root, 'The letter.txt'))) throw new Error('the cipher stage should be inside the zip, not next to it')
  const password = /key:\s+password (\S+)/.exec(solution)?.[1]
  if (!password) throw new Error('no zip password in the solution sheet:\n' + solution)

  // the zip: really password-protected, contains the rest of the chain, and its note names the next stage + keyword
  const py = [
    'import zipfile,sys,re',
    'z = zipfile.ZipFile(sys.argv[1])',
    'names = z.namelist()',
    'for must in ["read me.txt", "The letter.txt", "The mark.png", "the end.html"]:',
    '    assert must in names, (must, names)',
    'try:',
    '    z.read("read me.txt"); print("NO PASSWORD NEEDED"); sys.exit(1)',
    'except RuntimeError: pass',
    'z.setpassword(sys.argv[2].encode())',
    'note = z.read("read me.txt").decode()',
    'assert \'Open "The letter.txt"\' in note, note',
    'assert re.search(r"keyword: \\S+", note), note',
    'print("ok", len(names), note.strip().replace("\\n", " / "))',
  ].join('\n')
  const out = execFileSync('python', ['-c', py, path.join(root, 'Locked.zip'), password], { encoding: 'utf8', timeout: 30000 }).trim()
  if (!out.startsWith('ok')) throw new Error('zip check: ' + out)
  fs.writeFileSync(path.join(path.dirname(t.shotPath('x')), 'mystery-zip.txt'), out + '\n\n' + start + '\n' + solution)

  // ---- website hunt
  await t.clickText('Website')
  await t.sleep(300)
  await t.setInput('.keepalive:not([hidden]) .mm__mode input', 'https://hunt.example.netlify.app')
  await t.sleep(400)
  await t.clickText('Locked')
  await t.sleep(400)
  await t.capture('site-gate')
  const work2 = path.join(work, 'site-out')
  fs.mkdirSync(work2, { recursive: true })
  t.queuePick([work2])
  await t.clickText('Export the hunt')
  const solution2 = path.join(work2, 'The Drive — SOLUTION.txt')
  for (let i = 0; i < 120 && !fs.existsSync(solution2); i++) await t.sleep(250)
  await t.sleep(500)
  const start2 = fs.readFileSync(path.join(work2, 'The Drive', 'START.txt'), 'utf8')
  const first = /Go to (https:\/\/hunt\.example\.netlify\.app\/[a-z0-9-]+\/)/.exec(start2)?.[1]
  if (!first) throw new Error('site START.txt has no link: ' + start2)
  const siteDir = path.join(work2, 'The Drive', 'site')
  const slug = first.split('/').filter(Boolean).pop()
  if (!fs.existsSync(path.join(siteDir, slug, 'index.html')) || !fs.existsSync(path.join(siteDir, slug, 'The photo.png'))) throw new Error('first stage page missing for ' + slug)
  const pages = fs.readdirSync(siteDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  if (pages.length !== 6) throw new Error('expected 5 stage pages + finale, got ' + pages.join(','))
  const gate = pages.map((p) => fs.readFileSync(path.join(siteDir, p, 'index.html'), 'utf8')).find((h) => h.includes('type="password"'))
  if (!gate || gate.includes('Go to https://')) throw new Error('gate page missing or leaks the next link in clear text')
  fs.writeFileSync(path.join(path.dirname(t.shotPath('x')), 'mystery-site.txt'), start2 + '\n' + pages.join('\n') + '\n\n' + fs.readFileSync(solution2, 'utf8'))

  // ---- decode tab on our own outputs: the picture must say where to go next
  await t.clickText('Decode anything')
  await t.sleep(300)
  t.queuePick([path.join(root, 'The photo.png')])
  await t.exec(`document.querySelectorAll('.keepalive:not([hidden]) .mm__decode .dropzone button')[0].click()`)
  await t.sleep(900)
  const found = await t.text('.keepalive:not([hidden]) .mm__decode')
  if (!found.includes('Open "The recording.wav"')) throw new Error('decoder did not find the LSB pointer: ' + found.slice(0, 200))
  t.queuePick([path.join(root, 'The recording.wav')])
  await t.exec(`[...document.querySelectorAll('.keepalive:not([hidden]) .mm__decode .dropzone button')].at(-1).click()`)
  await t.sleep(900)
  await t.setInput('.keepalive:not([hidden]) .mm__decode textarea', 'Wkh sdvvzrug lv PLGQLJKW')
  await t.sleep(400)
  const guess = await t.text('.keepalive:not([hidden]) .mm__guess.is-best')
  if (!/the password is midnight/i.test(guess)) throw new Error('best guess wrong: ' + guess)
  await t.capture('decode')
}
