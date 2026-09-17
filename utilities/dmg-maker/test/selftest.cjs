// node utilities/dmg-maker/test/selftest.cjs
// Builds DMGs from synthetic apps and reads them back with lib/reader.cjs: structure checks (CRCs,
// B-trees, allocation bitmap) plus a byte-for-byte comparison of every file against what went in.
// What macOS itself thinks of the images is checked separately in CI (test/macos-verify.sh).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { demoEntries, writeFolder, writeZip } = require('./fixtures.cjs')
const { encodePng } = require('../../../tools/lib/png.cjs')
const dmg = require('../lib/index.cjs')
const { parseDSStore } = require('../lib/dsstore.cjs')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`)
  if (!ok) failures++
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const nfd = (s) => s.normalize('NFD')

/** Read the image back and compare it with the entries that were fed in. */
async function verifyImage(label, file, entries, { expectModes }) {
  const back = await dmg.readDmg(file)
  const bad = back.checks.filter((c) => !c.ok)
  check(`${label}: ${back.checks.length} structure checks`, bad.length === 0, bad.map((c) => `${c.name}: ${c.detail}`).join(' | '))

  const byPath = new Map(back.entries.map((e) => [nfd(e.path), e]))
  const problems = []
  for (const want of entries) {
    const got = byPath.get(nfd(want.path))
    if (!got) {
      problems.push('missing ' + want.path)
      continue
    }
    if (got.type !== want.type) problems.push(`${want.path}: type ${got.type} != ${want.type}`)
    if (want.type === 'symlink' && got.target !== want.target) problems.push(`${want.path}: target ${got.target} != ${want.target}`)
    if (expectModes && (got.mode & 0o777) !== want.mode) problems.push(`${want.path}: mode ${(got.mode & 0o777).toString(8)} != ${want.mode.toString(8)}`)
    if (want.type === 'file') {
      if (got.size !== want.data.length) problems.push(`${want.path}: size ${got.size} != ${want.data.length}`)
      else if (sha256(await dmg.extractFile(file, got.path)) !== sha256(want.data)) problems.push(`${want.path}: content differs`)
    }
  }
  check(`${label}: all ${entries.length} entries come back identical`, problems.length === 0, problems.slice(0, 5).join(' | '))
  return { back, byPath }
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-selftest-'))
  const started = Date.now()

  // ---- 1. the important case: a zip made on a Mac (modes + symlinks inside)
  {
    const entries = demoEntries({ caseClash: true })
    const zip = writeZip(path.join(work, 'Demo.zip'), entries)
    const info = await dmg.inspectSource(zip)
    check('zip: inspect reads Info.plist and the Mach-O header', info.kind === 'app-zip' && info.displayName === 'Demo App' && info.version === '1.2.3' && info.bundleId === 'com.example.demo' && info.arch.includes('arm64') && info.hasUnixModes)
    check('zip: warns that unsigned arm64 will not run', info.warnings.some((w) => /signature/i.test(w)))

    const out = path.join(work, 'zip.dmg')
    const phases = new Set()
    const res = await dmg.buildDmg({ source: zip, outPath: out, writeManifestHashes: true }, (p) => phases.add(p.phase))
    check('zip: build reports progress and a result', phases.has('write') && res.bytes === fs.statSync(out).size && res.manifest.length > entries.length)
    const { byPath } = await verifyImage('zip', out, entries, { expectModes: true })
    const apps = byPath.get('Applications')
    check('zip: Applications -> /Applications symlink is added', !!apps && apps.type === 'symlink' && apps.target === '/Applications')
    check('zip: Case.txt and case.txt both exist (case-sensitive volume)', byPath.has(nfd('Demo.app/Contents/Resources/Case.txt')) && byPath.has(nfd('Demo.app/Contents/Resources/case.txt')))
    const hashed = res.manifest.filter((m) => m.type === 'file' && m.sha256)
    check('zip: manifest carries a sha256 for every file', hashed.length === res.manifest.filter((m) => m.type === 'file').length)

    // the same zip wrapped in a top-level folder, as GitHub artifacts often are
    const nested = writeZip(path.join(work, 'Nested.zip'), entries, { prefix: 'build-output/' })
    const nestedInfo = await dmg.inspectSource(nested)
    check('zip: finds the .app one folder deep', nestedInfo.kind === 'app-zip' && nestedInfo.appName === 'Demo.app')
  }

  // ---- 2. an .app folder on Windows: no modes, no symlinks -> modes are inferred, the loss is reported
  {
    const entries = demoEntries()
    const app = writeFolder(path.join(work, 'folder-src'), entries)
    const info = await dmg.inspectSource(app)
    check('folder: inspect', info.kind === 'app-folder' && !info.hasUnixModes && info.displayName === 'Demo App')
    check('folder: warns about the framework symlinks Windows lost', info.warnings.some((w) => /zip/i.test(w) && /framework|symlink|link/i.test(w)), info.warnings.join(' | '))
    const out = path.join(work, 'folder.dmg')
    await dmg.buildDmg({ source: app, outPath: out, compression: 'none' })
    const onDisk = entries.filter((e) => e.type !== 'symlink')
    const { byPath } = await verifyImage('folder (uncompressed)', out, onDisk, { expectModes: false })
    const mode = (p) => (byPath.get(nfd(p))?.mode ?? 0) & 0o777
    check(
      'folder: executables are recognised (Mach-O, #! script, Contents/MacOS), data files are not',
      mode('Demo.app/Contents/MacOS/Demo') === 0o755 && mode('Demo.app/Contents/MacOS/helper.sh') === 0o755 && mode('Demo.app/Contents/Frameworks/Thing.framework/Versions/A/Thing') === 0o755 && mode('Demo.app/Contents/Info.plist') === 0o644,
    )
  }

  // ---- 3. size: thousands of files (multi-level catalog) and multi-chunk files of every chunk type
  {
    const entries = demoEntries({ many: 3000, bigBytes: 5 * 1024 * 1024 + 321 })
    const zip = writeZip(path.join(work, 'Big.zip'), entries)
    const out = path.join(work, 'big.dmg')
    const before = process.memoryUsage().rss
    const res = await dmg.buildDmg({ source: zip, outPath: out })
    const grew = (process.memoryUsage().rss - before) / 1024 / 1024
    const { back } = await verifyImage('big', out, entries, { expectModes: true })
    const types = new Set(back.blocks.flatMap((b) => b.chunks.map((c) => c.type)))
    check('big: image uses zlib, raw and zero-fill chunks', types.size >= 3, [...types].map((t) => '0x' + (t >>> 0).toString(16)).join(', '))
    check('big: compressed image is smaller than the volume', res.bytes < res.volumeBytes)
    console.log(`      (${entries.length} entries, volume ${(res.volumeBytes / 1048576).toFixed(1)} MB -> dmg ${(res.bytes / 1048576).toFixed(1)} MB, RSS grew ${grew.toFixed(0)} MB)`)
  }

  // ---- 4. the looks: cover picture, disk icon, icon positions
  {
    const entries = demoEntries()
    const zip = writeZip(path.join(work, 'Pretty.zip'), entries)
    const background = path.join(work, 'cover.png')
    fs.writeFileSync(background, encodePng(660, 400, (x, y) => [20 + Math.floor((x / 660) * 60), 24, 40 + Math.floor((y / 400) * 120), 255]))
    const icon = path.join(work, 'disk.icns')
    const png = encodePng(128, 128, () => [185, 242, 74, 255])
    const entry = Buffer.alloc(8)
    entry.write('ic07', 0, 'latin1')
    entry.writeUInt32BE(8 + png.length, 4)
    const head = Buffer.alloc(8)
    head.write('icns', 0, 'latin1')
    head.writeUInt32BE(16 + png.length, 4)
    fs.writeFileSync(icon, Buffer.concat([head, entry, png]))

    const out = path.join(work, 'pretty.dmg')
    await dmg.buildDmg({ source: zip, outPath: out, volumeName: 'Pretty Disk', background, volumeIcon: icon, window: { width: 660, height: 428 }, iconSize: 112, appPosition: { x: 170, y: 190 }, applicationsPosition: { x: 490, y: 190 } })
    const { back, byPath } = await verifyImage('pretty', out, entries, { expectModes: true })
    check('pretty: volume is named as asked', back.volume.name === 'Pretty Disk')
    check('pretty: cover picture is stored byte-for-byte', byPath.has('.background/background.png') && sha256(await dmg.extractFile(out, '.background/background.png')) === sha256(fs.readFileSync(background)))
    check('pretty: disk icon is stored and the root folder is flagged "has custom icon"', byPath.has('.VolumeIcon.icns') && (back.volume.rootFinderFlags & 0x0400) !== 0)
    const store = parseDSStore(await dmg.extractFile(out, '.DS_Store'))
    const has = (name, id) => store.records.some((r) => r.name === name && r.id === id)
    check('pretty: .DS_Store places both icons and sets the window + cover', has('Demo.app', 'Iloc') && has('Applications', 'Iloc') && has('.', 'bwsp') && has('.', 'icvp'), store.records.map((r) => `${r.name}:${r.id}`).join(' '))
  }

  // ---- 5. cancelling leaves nothing behind
  {
    const zip = writeZip(path.join(work, 'Abort.zip'), demoEntries({ bigBytes: 24 * 1024 * 1024 }))
    const out = path.join(work, 'abort.dmg')
    const controller = new AbortController()
    let aborted = null
    try {
      await dmg.buildDmg({ source: zip, outPath: out, signal: controller.signal }, (p) => {
        if (p.phase === 'write' && p.done > 0) controller.abort()
      })
    } catch (err) {
      aborted = err
    }
    check('abort: rejects with an AbortError and removes the partial file', !!aborted && /abort/i.test(aborted.name + aborted.message) && !fs.existsSync(out), aborted ? aborted.message : 'build finished')
  }

  // ---- 6. bad input fails with a message, not a crash
  {
    let message = ''
    try {
      await dmg.inspectSource(path.join(work, 'does-not-exist.zip'))
    } catch (err) {
      message = err.message
    }
    check('missing source gives a readable error', message.length > 0)
    const junk = path.join(work, 'junk.zip')
    fs.writeFileSync(junk, crypto.randomBytes(2048))
    message = ''
    try {
      await dmg.inspectSource(junk)
    } catch (err) {
      message = err.message
    }
    check('a corrupt zip gives a readable error', message.length > 0, 'no error thrown')
  }

  fs.rmSync(work, { recursive: true, force: true })
  console.log(`\n${failures ? failures + ' check(s) FAILED' : 'all checks passed'} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
