// Understands whatever people paste as "the expected checksum", and compares it with computed digests.
'use strict'

const BY_LENGTH = { 32: 'md5', 40: 'sha1', 64: 'sha256', 128: 'sha512' }
const LABELS = { md5: 'MD5', sha1: 'SHA-1', sha256: 'SHA-256', sha512: 'SHA-512' }
const LENGTH_HELP = 'MD5 has 32 hex characters, SHA-1 40, SHA-256 64 and SHA-512 128.'

const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p)

/**
 * Pull every checksum out of pasted text. Accepted:
 *   - a bare hash, any case, with spaces / colons / dashes between the bytes ("E3 B0 C4 …", certutil style)
 *   - `sha256sum` / `md5sum` lines:  "<hex>  name"  or  "<hex> *name"   (a whole SHA256SUMS file works)
 *   - BSD / macOS `shasum --tag` lines:  "SHA256 (name) = <hex>"
 *   - PowerShell Get-FileHash rows:  "SHA256  <HEX>  C:\path\name"
 *   - "sha256:<hex>" and Subresource-Integrity style "sha256-<base64>"
 *
 * @returns {{ ok: true, candidates: Array<{ hex: string, algo: string, fileName: string | null }> } | { ok: false, reason: 'empty' | 'length' | 'none', message: string }}
 */
function parseExpected(text) {
  const raw = String(text == null ? '' : text).trim()
  if (!raw) return { ok: false, reason: 'empty', message: 'Paste the checksum published next to the download.' }

  const candidates = []
  const add = (hex, fileName) => {
    const algo = BY_LENGTH[hex.length]
    if (!algo) return false
    const clean = hex.toLowerCase()
    const name = fileName ? baseName(fileName.trim()) : null
    if (!candidates.some((c) => c.hex === clean && c.fileName === name)) candidates.push({ hex: clean, algo, fileName: name || null })
    return true
  }

  // "e3 b0 c4 42 …" / "E3:B0:C4:…" / "0xE3B0…" / a long hash that an e-mail client wrapped onto two lines:
  // the whole text is one hash with separators in it
  const compact = raw.replace(/^0x/i, '').replace(/[\s:\-]/g, '')
  const allHex = /^[0-9a-fA-F]+$/.test(compact)
  if (allHex) add(compact, null)

  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue

    // SHA256 (file name) = hex
    const bsd = /^[A-Za-z0-9-]+\s*\((.+)\)\s*=\s*([0-9a-fA-F]+)$/.exec(s)
    if (bsd && add(bsd[2], bsd[1])) continue

    // sha256-<base64>  (npm lockfiles, <script integrity>)
    const sri = /(?:^|[\s"'])(?:md5|sha1|sha256|sha512)-([A-Za-z0-9+/_-]{22,}={0,2})(?=$|[\s"'?])/i.exec(s)
    if (sri) {
      const hex = Buffer.from(sri[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex')
      if (add(hex, null)) continue
    }

    // first run of hex with a checksum's length; whatever follows it on the line is the file name
    const runs = [...s.matchAll(/(?<![0-9a-zA-Z])[0-9a-fA-F]{32,128}(?![0-9a-zA-Z])/g)]
    const hit = runs.find((m) => BY_LENGTH[m[0].length])
    if (hit) {
      const rest = s.slice(hit.index + hit[0].length)
      const named = /^(?: [ *]| {2,}|\t+)(\S.*)$/.exec(rest)
      add(hit[0], named ? named[1] : null)
    }
  }
  if (candidates.length) return { ok: true, candidates }
  if (allHex) return { ok: false, reason: 'length', message: `That is ${compact.length} hex characters, which is no checksum length. ${LENGTH_HELP}` }
  return { ok: false, reason: 'none', message: `No checksum found in that text. ${LENGTH_HELP}` }
}

/**
 * Compare pasted candidates with hashed files.
 * A candidate that names a file only speaks for the file with that name; an unnamed one speaks for every file.
 *
 * @param {Array<{ hex: string, algo: string, fileName: string | null }>} candidates
 * @param {Array<{ id: string, name: string, digests: Record<string, string | null> }>} files
 * @returns {{ status: 'match' | 'mismatch' | 'no-files', files: Array<{ id: string, name: string, result: 'match' | 'mismatch' | 'unrelated', algo: string | null, expected: string | null, actual: string | null }> }}
 */
function judge(candidates, files) {
  if (!files.length) return { status: 'no-files', files: [] }
  const anyNamedHere = candidates.some((c) => c.fileName && files.some((f) => f.name.toLowerCase() === c.fileName.toLowerCase()))
  const out = files.map((file) => {
    const lower = file.name.toLowerCase()
    // when the paste names files we have, only the lines for this file count; otherwise every line does
    const mine = anyNamedHere ? candidates.filter((c) => c.fileName && c.fileName.toLowerCase() === lower) : candidates
    const hit = mine.find((c) => file.digests[c.algo] === c.hex)
    if (hit) return { id: file.id, name: file.name, result: 'match', algo: hit.algo, expected: hit.hex, actual: hit.hex }
    const miss = mine.find((c) => file.digests[c.algo])
    if (miss) return { id: file.id, name: file.name, result: 'mismatch', algo: miss.algo, expected: miss.hex, actual: file.digests[miss.algo] }
    return { id: file.id, name: file.name, result: 'unrelated', algo: null, expected: null, actual: null }
  })
  // One pasted hash, several files: it is "the" file's hash, so one match is a match and the others are simply not it.
  if (!anyNamedHere && out.some((f) => f.result === 'match')) {
    for (const f of out) if (f.result === 'mismatch') Object.assign(f, { result: 'unrelated', algo: null, expected: null, actual: null })
  }
  const status = out.some((f) => f.result === 'mismatch') ? 'mismatch' : out.some((f) => f.result === 'match') ? 'match' : 'mismatch'
  return { status, files: out }
}

/** `sha256sum`-compatible text: "<hex>  <name>" per line (two spaces = text mode, what the tools print by default). */
function sumsText(entries, algo, upper) {
  return entries
    .filter((e) => e.digests && e.digests[algo])
    .map((e) => `${upper ? e.digests[algo].toUpperCase() : e.digests[algo]}  ${e.name}\n`)
    .join('')
}

module.exports = { BY_LENGTH, LABELS, parseExpected, judge, sumsText, baseName }
