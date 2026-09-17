// Synthetic inputs for the DMG tests: a fake Mac app as a folder, and the same app as a Unix-style zip
// (with real modes and symlinks, like a zip made on a Mac), written by a tiny zip writer below.
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const crypto = require('node:crypto')

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Demo</string>
  <key>CFBundleDisplayName</key><string>Demo App</string>
  <key>CFBundleIdentifier</key><string>com.example.demo</string>
  <key>CFBundleShortVersionString</key><string>1.2.3</string>
  <key>CFBundleExecutable</key><string>Demo</string>
  <key>CFBundleIconFile</key><string>icon</string>
</dict></plist>
`

/** Looks like a thin arm64 Mach-O to anything that only reads the header. */
function fakeMachO(extraBytes = 4096) {
  const head = Buffer.alloc(32)
  head.writeUInt32LE(0xfeedfacf, 0) // MH_MAGIC_64
  head.writeUInt32LE(0x0100000c, 4) // CPU_TYPE_ARM64
  head.writeUInt32LE(2, 12) // MH_EXECUTE
  return Buffer.concat([head, crypto.randomBytes(extraBytes)])
}

/**
 * The app as a list of entries: { path, type: 'dir'|'file'|'symlink', mode, data?, target? }.
 * `many` adds that many small files so the catalog B-tree needs several levels.
 */
function demoEntries({ many = 0, bigBytes = 0, caseClash = false } = {}) {
  const e = []
  const dir = (p) => e.push({ path: p, type: 'dir', mode: 0o755 })
  const file = (p, data, mode = 0o644) => e.push({ path: p, type: 'file', mode, data: Buffer.isBuffer(data) ? data : Buffer.from(data) })
  const link = (p, target) => e.push({ path: p, type: 'symlink', mode: 0o755, target })

  dir('Demo.app')
  dir('Demo.app/Contents')
  file('Demo.app/Contents/Info.plist', INFO_PLIST)
  file('Demo.app/Contents/PkgInfo', 'APPL????')
  dir('Demo.app/Contents/MacOS')
  file('Demo.app/Contents/MacOS/Demo', fakeMachO(), 0o755)
  file('Demo.app/Contents/MacOS/helper.sh', '#!/bin/sh\necho hi\n', 0o755)
  dir('Demo.app/Contents/Resources')
  file('Demo.app/Contents/Resources/empty.txt', '')
  file('Demo.app/Contents/Resources/Ünïcödé – name ✓.txt', 'unicode name\n')
  file('Demo.app/Contents/Resources/' + 'long-name-'.repeat(20) + '.dat', 'long name\n')
  file('Demo.app/Contents/Resources/Case.txt', 'upper\n')
  if (caseClash) file('Demo.app/Contents/Resources/case.txt', 'lower\n') // zip only: Windows folders cannot hold both
  dir('Demo.app/Contents/Frameworks')
  dir('Demo.app/Contents/Frameworks/Thing.framework')
  dir('Demo.app/Contents/Frameworks/Thing.framework/Versions')
  dir('Demo.app/Contents/Frameworks/Thing.framework/Versions/A')
  file('Demo.app/Contents/Frameworks/Thing.framework/Versions/A/Thing', fakeMachO(9000), 0o755)
  dir('Demo.app/Contents/Frameworks/Thing.framework/Versions/A/Resources')
  file('Demo.app/Contents/Frameworks/Thing.framework/Versions/A/Resources/Info.plist', INFO_PLIST)
  link('Demo.app/Contents/Frameworks/Thing.framework/Versions/Current', 'A')
  link('Demo.app/Contents/Frameworks/Thing.framework/Thing', 'Versions/Current/Thing')
  link('Demo.app/Contents/Frameworks/Thing.framework/Resources', 'Versions/Current/Resources')

  if (bigBytes) {
    // half compressible, half random: exercises zlib chunks, raw chunks and chunk boundaries
    const half = Math.floor(bigBytes / 2)
    file('Demo.app/Contents/Resources/big.bin', Buffer.concat([Buffer.alloc(half, 0x41), crypto.randomBytes(bigBytes - half)]))
    file('Demo.app/Contents/Resources/zeros.bin', Buffer.alloc(3 * 1024 * 1024)) // all-zero chunks
  }
  if (many) {
    dir('Demo.app/Contents/Resources/many')
    for (let i = 0; i < many; i++) file(`Demo.app/Contents/Resources/many/item-${String(i).padStart(5, '0')}.json`, `{"i":${i}}`)
  }
  return e
}

/** Write the entries to disk. Windows cannot hold modes, and symlinks need privileges, so both are skipped. */
function writeFolder(root, entries) {
  for (const entry of entries) {
    const full = path.join(root, entry.path)
    if (entry.type === 'dir') fs.mkdirSync(full, { recursive: true })
    else if (entry.type === 'file') {
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, entry.data)
    }
  }
  return path.join(root, 'Demo.app')
}

// ---------------------------------------------------------------- tiny zip writer (Unix attributes)

const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

function writeZip(file, entries, { prefix = '' } = {}) {
  const parts = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(prefix + entry.path + (entry.type === 'dir' ? '/' : ''), 'utf8')
    const raw = entry.type === 'symlink' ? Buffer.from(entry.target, 'utf8') : entry.type === 'file' ? entry.data : Buffer.alloc(0)
    const deflated = raw.length > 64 ? zlib.deflateRawSync(raw) : null
    const useDeflate = !!deflated && deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const crc = zlib.crc32(raw) >>> 0
    const mode = (entry.type === 'dir' ? S_IFDIR : entry.type === 'symlink' ? S_IFLNK : S_IFREG) | entry.mode

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(0x6000, 10) // time
    local.writeUInt16LE(0x5b21, 12) // date 2025-09-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    parts.push(local, name, body)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE((3 << 8) | 30, 4) // made by: Unix
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(useDeflate ? 8 : 0, 10)
    cd.writeUInt16LE(0x6000, 12)
    cd.writeUInt16LE(0x5b21, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(((mode << 16) | (entry.type === 'dir' ? 0x10 : 0)) >>> 0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)
    offset += 30 + name.length + body.length
  }
  const cdBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cdBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  fs.writeFileSync(file, Buffer.concat([...parts, cdBuf, end]))
  return file
}

module.exports = { demoEntries, writeFolder, writeZip, fakeMachO, INFO_PLIST }
