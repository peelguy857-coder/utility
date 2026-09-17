// Independent look at a UDIF .dmg (does not use lib/): prints the koly trailer, the plist skeleton and
// the block table, or unpacks the image to the raw volume bytes. Used by CI to compare our images with
// ones Apple's hdiutil made.
//   node dump-udif.cjs dump <image.dmg>
//   node dump-udif.cjs raw  <image.dmg> <out.img>
const fs = require('node:fs')
const zlib = require('node:zlib')

function parse(file) {
  const fd = fs.openSync(file, 'r')
  const size = fs.fstatSync(fd).size
  const read = (pos, len) => {
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, pos)
    return buf
  }
  const k = read(size - 512, 512)
  const u32 = (o) => k.readUInt32BE(o)
  const u64 = (o) => Number(k.readBigUInt64BE(o))
  const koly = {
    signature: k.toString('latin1', 0, 4), version: u32(4), headerSize: u32(8), flags: u32(12),
    runningDataForkOffset: u64(16), dataForkOffset: u64(24), dataForkLength: u64(32), rsrcForkOffset: u64(40), rsrcForkLength: u64(48),
    segmentNumber: u32(56), segmentCount: u32(60), segmentId: k.subarray(64, 80).toString('hex'),
    dataChecksum: { type: u32(80), bits: u32(84), value: u32(88).toString(16) },
    xmlOffset: u64(216), xmlLength: u64(224), reserved1NonZero: k.subarray(232, 352).some((b) => b !== 0),
    masterChecksum: { type: u32(352), bits: u32(356), value: u32(360).toString(16) },
    imageVariant: u32(488), sectorCount: u64(492), tail: k.subarray(500, 512).toString('hex'),
  }
  const xml = read(koly.xmlOffset, koly.xmlLength).toString('utf8')
  const blocks = []
  const re = /<key>(CFName|Name|ID|Attributes)<\/key>\s*<string>([^<]*)<\/string>|<key>Data<\/key>\s*<data>([^<]*)<\/data>/g
  let current = {}
  for (let m; (m = re.exec(xml)); ) {
    if (m[1]) current[m[1]] = m[2]
    else current.data = Buffer.from(m[3].replace(/\s+/g, ''), 'base64')
    if (current.data && current.Name !== undefined && current.ID !== undefined) {
      blocks.push(current)
      current = {}
    }
  }
  return { fd, size, read, koly, xml, blocks }
}

function mish(data) {
  const chunks = []
  const count = data.readUInt32BE(200)
  for (let i = 0; i < count; i++) {
    const o = 204 + i * 40
    chunks.push({ type: data.readUInt32BE(o), comment: data.readUInt32BE(o + 4), sector: Number(data.readBigUInt64BE(o + 8)), sectors: Number(data.readBigUInt64BE(o + 16)), offset: Number(data.readBigUInt64BE(o + 24)), length: Number(data.readBigUInt64BE(o + 32)) })
  }
  return {
    signature: data.toString('latin1', 0, 4), version: data.readUInt32BE(4), firstSector: Number(data.readBigUInt64BE(8)), sectorCount: Number(data.readBigUInt64BE(16)),
    dataOffset: Number(data.readBigUInt64BE(24)), buffersNeeded: data.readUInt32BE(32), blockDescriptors: data.readUInt32BE(36), reservedNonZero: data.subarray(40, 64).some((b) => b !== 0),
    checksum: { type: data.readUInt32BE(64), bits: data.readUInt32BE(68), value: data.readUInt32BE(72).toString(16) }, chunkCount: count, bytes: data.length, chunks,
  }
}

const [, , command, file, out] = process.argv
const img = parse(file)
if (command === 'dump') {
  console.log('file size', img.size, '| size % 512 =', img.size % 512)
  console.log('koly', JSON.stringify(img.koly))
  console.log('plist keys in order:', (img.xml.match(/<key>[^<]+<\/key>/g) || []).map((s) => s.slice(5, -6)).join(' '))
  console.log('plist head:', JSON.stringify(img.xml.slice(0, 260)))
  for (const b of img.blocks) {
    const m = mish(b.data)
    const { chunks, ...head } = m
    console.log(`blkx ID=${b.ID} Attributes=${b.Attributes} Name=${JSON.stringify(b.Name)} CFName=${JSON.stringify(b.CFName)}`)
    console.log('  mish', JSON.stringify(head))
    const show = chunks.length > 8 ? [...chunks.slice(0, 4), null, ...chunks.slice(-3)] : chunks
    for (const c of show) console.log(c ? `  chunk type=0x${c.type.toString(16)} comment=${c.comment} sector=${c.sector} sectors=${c.sectors} offset=${c.offset} length=${c.length}` : '  ...')
  }
  const other = (img.xml.match(/<key>(plst|cSum|nsiz|size)<\/key>/g) || []).join(' ')
  console.log('other resources:', other || 'none')
} else if (command === 'raw') {
  const fdOut = fs.openSync(out, 'w')
  for (const b of img.blocks) {
    const m = mish(b.data)
    for (const c of m.chunks) {
      if (c.type === 0xffffffff || c.type === 0x7ffffffe) continue
      const bytes = c.sectors * 512
      let data
      if (c.type === 0x80000005) data = zlib.inflateSync(img.read(img.koly.dataForkOffset + m.dataOffset + c.offset, c.length))
      else if (c.type === 1) data = img.read(img.koly.dataForkOffset + m.dataOffset + c.offset, c.length)
      else data = Buffer.alloc(bytes)
      if (data.length !== bytes) throw new Error(`chunk at sector ${c.sector}: ${data.length} bytes, expected ${bytes}`)
      fs.writeSync(fdOut, data, 0, bytes, (m.firstSector + c.sector) * 512)
    }
  }
  fs.closeSync(fdOut)
  console.log('wrote', out, fs.statSync(out).size, 'bytes')
} else {
  console.error('usage: dump-udif.cjs dump|raw <image.dmg> [out.img]')
  process.exit(2)
}
