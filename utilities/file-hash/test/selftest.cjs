// node utilities/file-hash/test/selftest.cjs
'use strict'
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { hashFile, ALGORITHMS, describeError } = require('../lib/hasher.cjs')
const { parseExpected, judge, sumsText } = require('../lib/expected.cjs')

let passed = 0
const pending = []
function test(name, fn) {
  pending.push(async () => {
    try {
      await fn()
      passed++
      console.log('  ok   ' + name)
    } catch (err) {
      console.log('  FAIL ' + name + '\n       ' + String(err && err.stack ? err.stack : err).split('\n').join('\n       '))
      process.exitCode = 1
    }
  })
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utility-file-hash-'))
const file = (name, data) => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, data)
  return p
}
const oneShot = (data) => Object.fromEntries(ALGORITHMS.map((a) => [a, crypto.createHash(a).update(data).digest('hex')]))
const fdIsClosed = (fd) => {
  try {
    fs.fstatSync(fd)
    return false
  } catch (err) {
    return err.code === 'EBADF'
  }
}

// published test vectors (RFC 1321, FIPS 180)
const EMPTY = {
  md5: 'd41d8cd98f00b204e9800998ecf8427e',
  sha1: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  sha512: 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e',
}
const ABC = {
  md5: '900150983cd24fb0d6963f7d28e17f72',
  sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d',
  sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  sha512: 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
}

// ---------------------------------------------------------------- hashing

test('empty file: the published vectors', async () => {
  const res = await hashFile(file('empty.bin', '')).promise
  assert.equal(res.size, 0)
  assert.deepEqual(res.digests, EMPTY)
})

test('"abc": the published vectors', async () => {
  const res = await hashFile(file('abc.txt', 'abc')).promise
  assert.equal(res.size, 3)
  assert.deepEqual(res.digests, ABC)
})

test('5 MB generated file: equals Node one-shot digests, progress is throttled and complete', async () => {
  const data = Buffer.alloc(5 * 1024 * 1024 + 123)
  let x = 0x9e3779b9
  for (let i = 0; i < data.length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    data[i] = x >>> 24
  }
  const p = file('five-mb.bin', data)
  const events = []
  // small chunks so that many progress ticks would fire without throttling
  const res = await hashFile(p, { chunkSize: 16 * 1024, progressIntervalMs: 100, onProgress: (e) => events.push({ ...e, at: Date.now() }) }).promise
  assert.equal(res.size, data.length)
  assert.deepEqual(res.digests, oneShot(data))
  assert.ok(events.length >= 1, 'no progress at all')
  assert.ok(events.length <= 2 + Math.ceil(res.ms / 100) + 1, `progress not throttled: ${events.length} events in ${res.ms} ms`)
  for (let i = 1; i < events.length - 1; i++) assert.ok(events[i].at - events[i - 1].at >= 95, 'two progress events closer than the interval')
  const last = events[events.length - 1]
  assert.equal(last.done, data.length)
  assert.equal(last.total, data.length)
  assert.ok(events.every((e, i) => i === 0 || e.done >= events[i - 1].done), 'progress went backwards')
})

test('cancel mid-way: rejects with CANCELLED, stream destroyed, file handle closed, file deletable', async () => {
  const p = file('cancel-me.bin', Buffer.alloc(24 * 1024 * 1024, 7))
  let job
  let fd = null
  let seen = 0
  job = hashFile(p, {
    chunkSize: 64 * 1024,
    progressIntervalMs: 0,
    onProgress: (e) => {
      seen = e.done
      if (fd == null && job.stream) fd = job.stream.fd
      if (e.done >= 2 * 1024 * 1024) job.cancel()
    },
  })
  await assert.rejects(job.promise, (err) => err.code === 'CANCELLED')
  assert.ok(seen >= 2 * 1024 * 1024 && seen < 24 * 1024 * 1024, `cancel was not mid-way (${seen} bytes)`)
  assert.equal(job.stream.destroyed, true)
  assert.equal(job.stream.closed, true)
  assert.equal(typeof fd, 'number')
  assert.ok(fdIsClosed(fd), 'file descriptor still open after cancel')
  fs.unlinkSync(p)
  assert.equal(fs.existsSync(p), false)
})

test('cancel before the read starts', async () => {
  const job = hashFile(file('early.bin', 'abc'))
  job.cancel()
  await assert.rejects(job.promise, (err) => err.code === 'CANCELLED')
})

test('errors: missing file, folder', async () => {
  await assert.rejects(hashFile(path.join(dir, 'nope.bin')).promise, (err) => err.code === 'ENOENT' && /moved, renamed or deleted/.test(describeError(err)))
  await assert.rejects(hashFile(dir).promise, (err) => err.code === 'EISDIR' && /folder/.test(describeError(err)))
})

// ---------------------------------------------------------------- pasted checksums

const one = (text) => {
  const res = parseExpected(text)
  assert.equal(res.ok, true, `not parsed: ${text}`)
  assert.equal(res.candidates.length, 1)
  return res.candidates[0]
}

test('parseExpected: bare hashes of all four lengths, any case, surrounding space', () => {
  for (const algo of ALGORITHMS) {
    assert.deepEqual(one(ABC[algo]), { hex: ABC[algo], algo, fileName: null })
    assert.deepEqual(one(`  ${ABC[algo].toUpperCase()} \n`), { hex: ABC[algo], algo, fileName: null })
  }
})

test('parseExpected: spaces, colons and dashes between the bytes', () => {
  const pairs = ABC.sha256.match(/../g)
  assert.equal(one(pairs.join(' ')).hex, ABC.sha256)
  assert.equal(one(pairs.join(':').toUpperCase()).hex, ABC.sha256)
  assert.equal(one(ABC.md5.match(/.{8}/g).join('-')).algo, 'md5')
  assert.equal(one('0x' + ABC.sha1).algo, 'sha1')
  // wrapped by an e-mail client: read as one SHA-512 first (the two halves stay candidates, they could be two SHA-256)
  const wrapped = parseExpected(ABC.sha512.slice(0, 64) + '\n' + ABC.sha512.slice(64))
  assert.deepEqual(wrapped.candidates[0], { hex: ABC.sha512, algo: 'sha512', fileName: null })
  assert.equal(wrapped.candidates.length, 3)
})

test('parseExpected: sha256sum lines, text and binary mode, paths', () => {
  assert.deepEqual(one(`${ABC.sha256}  ubuntu-26.04-desktop-amd64.iso`), { hex: ABC.sha256, algo: 'sha256', fileName: 'ubuntu-26.04-desktop-amd64.iso' })
  assert.deepEqual(one(`${ABC.sha256} *my file (1).zip`), { hex: ABC.sha256, algo: 'sha256', fileName: 'my file (1).zip' })
  assert.equal(one(`${ABC.md5}  ./dist/app.exe`).fileName, 'app.exe')
  assert.equal(one(`SHA256 (paper-1.21.jar) = ${ABC.sha256}`).fileName, 'paper-1.21.jar')
  assert.equal(one(`SHA256          ${ABC.sha256.toUpperCase()}       C:\\Users\\me\\Downloads\\setup.exe`).fileName, 'setup.exe')
  assert.equal(one(`sha256:${ABC.sha256}`).hex, ABC.sha256)
  assert.equal(one(`SHA-1: ${ABC.sha1}`).algo, 'sha1')
  // a file that is named after a hash, in BSD notation: the hash after "=" wins
  assert.equal(one(`SHA1 (${EMPTY.md5}.bin) = ${ABC.sha1}`).hex, ABC.sha1)
})

test('parseExpected: Subresource-Integrity / npm style base64', () => {
  const b64 = Buffer.from(ABC.sha512, 'hex').toString('base64')
  assert.deepEqual(one(`sha512-${b64}`), { hex: ABC.sha512, algo: 'sha512', fileName: null })
  assert.equal(one(`"integrity": "sha256-${Buffer.from(ABC.sha256, 'hex').toString('base64')}"`).hex, ABC.sha256)
})

test('parseExpected: a whole SHA256SUMS file', () => {
  const res = parseExpected(`${EMPTY.sha256}  empty.bin\n${ABC.sha256}  abc.txt\n\n# comment\n`)
  assert.equal(res.ok, true)
  assert.deepEqual(res.candidates.map((c) => c.fileName), ['empty.bin', 'abc.txt'])
})

test('parseExpected: refusals say why', () => {
  assert.equal(parseExpected('').reason, 'empty')
  assert.equal(parseExpected('   \n').reason, 'empty')
  const short = parseExpected(ABC.sha256.slice(0, 60))
  assert.equal(short.reason, 'length')
  assert.match(short.message, /60 hex characters/)
  assert.equal(parseExpected('hello world').reason, 'none')
  assert.equal(parseExpected('zz' + ABC.sha256).reason, 'none')
})

test('judge: match names the algorithm; mismatch shows both values', () => {
  const files = [{ id: 'a', name: 'abc.txt', digests: ABC }]
  for (const algo of ALGORITHMS) {
    const v = judge(parseExpected(ABC[algo].toUpperCase()).candidates, files)
    assert.equal(v.status, 'match')
    assert.deepEqual(v.files[0], { id: 'a', name: 'abc.txt', result: 'match', algo, expected: ABC[algo], actual: ABC[algo] })
  }
  const bad = judge(parseExpected(EMPTY.sha256).candidates, files)
  assert.equal(bad.status, 'mismatch')
  assert.deepEqual(bad.files[0], { id: 'a', name: 'abc.txt', result: 'mismatch', algo: 'sha256', expected: EMPTY.sha256, actual: ABC.sha256 })
  assert.equal(judge(parseExpected(ABC.md5).candidates, []).status, 'no-files')
})

test('judge: one pasted hash, several files: the matching one is found, the rest is left alone', () => {
  const files = [
    { id: 'a', name: 'abc.txt', digests: ABC },
    { id: 'e', name: 'empty.bin', digests: EMPTY },
  ]
  const v = judge(parseExpected(EMPTY.sha1).candidates, files)
  assert.equal(v.status, 'match')
  assert.deepEqual(v.files.map((f) => f.result), ['unrelated', 'match'])
  assert.equal(v.files[1].algo, 'sha1')
  const none = judge(parseExpected('f'.repeat(64)).candidates, files)
  assert.equal(none.status, 'mismatch')
  assert.deepEqual(none.files.map((f) => f.result), ['mismatch', 'mismatch'])
})

test('judge: a SUMS file is applied per file name (case-insensitive), a wrong line is a mismatch', () => {
  const files = [
    { id: 'a', name: 'ABC.txt', digests: ABC },
    { id: 'e', name: 'empty.bin', digests: EMPTY },
  ]
  const good = judge(parseExpected(`${EMPTY.sha256}  empty.bin\n${ABC.sha256}  abc.txt`).candidates, files)
  assert.equal(good.status, 'match')
  assert.deepEqual(good.files.map((f) => f.result), ['match', 'match'])
  // lines swapped: every hash exists in the list, but not for the right file
  const swapped = judge(parseExpected(`${ABC.sha256}  empty.bin\n${EMPTY.sha256}  abc.txt`).candidates, files)
  assert.equal(swapped.status, 'mismatch')
  assert.deepEqual(swapped.files.map((f) => f.result), ['mismatch', 'mismatch'])
  // the download was renamed: fall back to comparing the hash alone
  const renamed = judge(parseExpected(`${ABC.sha256}  original-name.txt`).candidates, [files[0]])
  assert.equal(renamed.status, 'match')
})

test('sumsText: what sha256sum prints, and parseExpected reads it back', () => {
  const entries = [
    { name: 'abc.txt', digests: ABC },
    { name: 'empty.bin', digests: EMPTY },
    { name: 'no-md5.bin', digests: { ...EMPTY, md5: null } },
  ]
  assert.equal(sumsText(entries, 'sha256', false), `${ABC.sha256}  abc.txt\n${EMPTY.sha256}  empty.bin\n${EMPTY.sha256}  no-md5.bin\n`)
  assert.equal(sumsText(entries, 'md5', true), `${ABC.md5.toUpperCase()}  abc.txt\n${EMPTY.md5.toUpperCase()}  empty.bin\n`)
  const back = parseExpected(sumsText(entries.slice(0, 2), 'sha512', true))
  assert.deepEqual(back.candidates, [
    { hex: ABC.sha512, algo: 'sha512', fileName: 'abc.txt' },
    { hex: EMPTY.sha512, algo: 'sha512', fileName: 'empty.bin' },
  ])
})

// ---------------------------------------------------------------- the backend, with a fake ctx

test('backend: only hashes allowed paths; progress events; sidecar file; cancel; dispose', async () => {
  const backend = require('../main.cjs')
  const h = backend.handlers
  const allowed = new Set()
  const events = []
  const ctx = { isAllowed: (p) => allowed.has(p), emit: (event, payload) => events.push({ event, ...payload }) }

  const p = file('backend.txt', 'abc')
  await assert.rejects(h.hash({ id: 'j1', path: p }, ctx), /not shared with the app/)
  await assert.rejects(h.hash({ id: '../x', path: p }, ctx), /Bad job id/)
  allowed.add(p)
  const res = await h.hash({ id: 'j1', path: p }, ctx)
  assert.deepEqual(res.digests, ABC)
  assert.equal(res.name, 'backend.txt')
  assert.equal(res.size, 3)
  assert.ok(events.some((e) => e.event === 'progress' && e.id === 'j1' && e.done === 3 && e.total === 3))

  const cmp = await h.compare({ text: ABC.sha256.toUpperCase(), ids: ['j1', 'unknown'] }, ctx)
  assert.equal(cmp.verdict.status, 'match')
  assert.equal(cmp.verdict.files[0].algo, 'sha256')
  assert.equal((await h.compare({ text: 'nonsense', ids: ['j1'] }, ctx)).parsed.ok, false)

  assert.deepEqual(await h.sums({ ids: ['j1'], algo: 'sha256', upper: false }, ctx), { text: `${ABC.sha256}  backend.txt\n`, count: 1 })
  const saved = await h.saveSidecar({ id: 'j1', algo: 'sha256', upper: false }, ctx)
  assert.equal(saved.path, p + '.sha256')
  assert.equal(fs.readFileSync(saved.path, 'utf8'), `${ABC.sha256}  backend.txt\n`)
  assert.equal((await h.saveSidecar({ id: 'j1', algo: 'sha256', upper: true }, ctx)).exists, true) // never silently replaced
  assert.equal(fs.readFileSync(saved.path, 'utf8'), `${ABC.sha256}  backend.txt\n`)
  assert.equal((await h.saveSidecar({ id: 'j1', algo: 'sha256', upper: true, overwrite: true }, ctx)).exists, false)
  assert.equal(fs.readFileSync(saved.path, 'utf8'), `${ABC.sha256.toUpperCase()}  backend.txt\n`)
  await assert.rejects(h.saveSidecar({ id: 'j1', algo: 'crc32' }, ctx), /Unknown algorithm/)
  await assert.rejects(h.saveSidecar({ id: 'nope', algo: 'md5' }, ctx), /Hash the file first/)

  // three big files: two run, one waits; cancel one running and the queued one
  const big = ['big1.bin', 'big2.bin', 'big3.bin'].map((n) => file(n, Buffer.alloc(48 * 1024 * 1024, 1)))
  big.forEach((b) => allowed.add(b))
  const runs = big.map((b, i) => h.hash({ id: 'big' + i, path: b }, ctx))
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(await h.cancel({ id: 'big0' }, ctx), { cancelled: true })
  assert.deepEqual(await h.cancel({ id: 'big2' }, ctx), { cancelled: true })
  const [r0, r1, r2] = await Promise.all(runs)
  assert.equal(r0.cancelled, true)
  assert.equal(r2.cancelled, true)
  assert.equal(r1.digests.sha256, crypto.createHash('sha256').update(Buffer.alloc(48 * 1024 * 1024, 1)).digest('hex'))
  assert.deepEqual(await h.cancel({ id: 'big1' }, ctx), { cancelled: false }) // already done

  const late = h.hash({ id: 'late', path: big[0] }, ctx)
  await new Promise((r) => setTimeout(r, 20))
  await backend.dispose()
  assert.equal((await late).cancelled, true)
  await assert.rejects(h.hash({ id: 'after', path: p }, ctx), /closing/)
})

;(async () => {
  for (const job of pending) await job()
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    assert.equal(fs.existsSync(dir), false, 'temp folder could not be removed: a file is still open')
  } catch (err) {
    console.log('  FAIL cleanup: ' + err.message)
    process.exitCode = 1
  }
  console.log(process.exitCode ? '\nfile-hash: FAILED' : `\nfile-hash: ${passed} checks passed`)
})()
