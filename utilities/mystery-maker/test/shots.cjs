// Loads the example trail, exports it, then checks the files with tools a player would use:
// Python's zipfile for the password (a real ZipCrypto implementation), plus the in-page engines.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

module.exports = async (t) => {
  const engines = await t.exec(`window.__mysteryTest ? window.__mysteryTest() : { skipped: true }`)
  fs.writeFileSync(path.join(path.dirname(t.shotPath('x')), 'mystery-engines.json'), JSON.stringify(engines, null, 2))
  for (const [k, v] of Object.entries(engines)) if (v !== true) throw new Error(`engine check failed: ${k} = ${JSON.stringify(v)}`)

  const work = path.join(t.tmpDir(), 'mystery')
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })

  if (!(await t.clickText('Load example'))) throw new Error('no Load example button')
  await t.sleep(500)
  await t.capture('example')
  await t.clickText('Scrambled note')
  await t.sleep(400)
  await t.capture('cipher-step')
  await t.clickText('A voice memo')
  await t.sleep(900)
  await t.capture('audio-step')

  t.queuePick([work])
  if (!(await t.clickText('Export the trail'))) throw new Error('no Export button')
  const root = path.join(work, 'The Drive')
  for (let i = 0; i < 120 && !fs.existsSync(path.join(work, 'The Drive — SOLUTION.txt')); i++) await t.sleep(250)
  await t.sleep(500)
  await t.capture('exported')

  const solution = fs.readFileSync(path.join(work, 'The Drive — SOLUTION.txt'), 'utf8')
  for (const must of ['READ ME.txt', 'photo.png', 'recording.wav', 'archive.zip', 'LANTERN']) if (!solution.includes(must)) throw new Error('solution sheet is missing ' + must)
  for (const f of ['READ ME.txt', 'photo.png', 'recording.wav', 'archive.zip']) if (!fs.existsSync(path.join(root, f))) throw new Error('missing output ' + f)
  if (fs.existsSync(path.join(root, 'message.txt'))) throw new Error('the cipher step should be inside the zip, not next to it')

  // the zip: really password-protected, really extractable with the password
  const py = [
    'import zipfile,sys',
    `z = zipfile.ZipFile(sys.argv[1])`,
    'names = z.namelist()',
    'assert any(n.endswith("message.txt") for n in names), names',
    'assert any(n.endswith("the end.html") for n in names), names',
    'try:',
    '    z.read([n for n in names if n.endswith("message.txt")][0]); print("NO PASSWORD NEEDED"); sys.exit(1)',
    'except RuntimeError: pass',
    'z.setpassword(b"LANTERN")',
    'data = z.read([n for n in names if n.endswith("message.txt")][0]).decode()',
    'print("ok", len(names), data.strip()[:40])',
  ].join('\n')
  const out = execFileSync('python', ['-c', py, path.join(root, 'archive.zip')], { encoding: 'utf8', timeout: 30000 }).trim()
  if (!out.startsWith('ok')) throw new Error('zip check: ' + out)
  fs.writeFileSync(path.join(path.dirname(t.shotPath('x')), 'mystery-zip.txt'), out + '\n' + solution)

  // decode tab on our own outputs
  await t.clickText('Decode anything')
  await t.sleep(300)
  t.queuePick([path.join(root, 'photo.png')])
  await t.exec(`document.querySelectorAll('.keepalive:not([hidden]) .mm__decode .dropzone button')[0].click()`)
  await t.sleep(900)
  const found = await t.text('.keepalive:not([hidden]) .mm__decode')
  if (!found.includes('zip password is what you hear')) throw new Error('decoder did not find the LSB message: ' + found.slice(0, 200))
  t.queuePick([path.join(root, 'recording.wav')])
  await t.exec(`[...document.querySelectorAll('.keepalive:not([hidden]) .mm__decode .dropzone button')].at(-1).click()`)
  await t.sleep(900)
  await t.setInput('.keepalive:not([hidden]) .mm__decode textarea', 'Wkh sdvvzrug lv PLGQLJKW')
  await t.sleep(400)
  const guess = await t.text('.keepalive:not([hidden]) .mm__guess.is-best')
  if (!/the password is midnight/i.test(guess)) throw new Error('best guess wrong: ' + guess)
  await t.capture('decode')
}
