// A ZIP writer with optional password (traditional PKWARE "ZipCrypto"), the kind Windows, 7-Zip and
// macOS all open with a password prompt. Deflate comes from the browser's CompressionStream.

export interface ZipEntry {
  name: string
  data: Uint8Array
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** PKWARE traditional encryption: three rolling keys seeded by the password. */
class ZipCrypto {
  private k0 = 0x12345678
  private k1 = 0x23456789
  private k2 = 0x34567890

  constructor(password: string) {
    for (const b of new TextEncoder().encode(password)) this.update(b)
  }

  private update(byte: number) {
    this.k0 = (CRC_TABLE[(this.k0 ^ byte) & 0xff] ^ (this.k0 >>> 8)) >>> 0
    this.k1 = (Math.imul((this.k1 + (this.k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0
    this.k2 = (CRC_TABLE[(this.k2 ^ (this.k1 >>> 24)) & 0xff] ^ (this.k2 >>> 8)) >>> 0
  }

  private stream(): number {
    const t = (this.k2 | 2) & 0xffff
    return (Math.imul(t, t ^ 1) >>> 8) & 0xff
  }

  encrypt(data: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.length)
    for (let i = 0; i < data.length; i++) {
      const c = data[i]
      out[i] = c ^ this.stream()
      this.update(c)
    }
    return out
  }
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const dosTime = (d: Date) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff
const dosDate = (d: Date) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff

/** Build a .zip in memory. With `password`, every entry is ZipCrypto-encrypted. */
export async function buildZip(entries: ZipEntry[], password?: string): Promise<Uint8Array> {
  const now = new Date()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const enc = new TextEncoder()

  for (const entry of entries) {
    const name = enc.encode(entry.name.replace(/\\/g, '/'))
    const crc = crc32(entry.data)
    const deflated = entry.data.length > 32 ? await deflateRaw(entry.data) : null
    const useDeflate = !!deflated && deflated.length < entry.data.length
    let body = useDeflate ? deflated! : entry.data
    let flags = 0x0800 // UTF-8 names
    if (password) {
      flags |= 0x0001
      const header = new Uint8Array(12)
      crypto.getRandomValues(header)
      header[11] = (crc >>> 24) & 0xff // what every extractor checks the password against
      const zc = new ZipCrypto(password)
      body = new Uint8Array([...zc.encrypt(header), ...zc.encrypt(body)])
    }
    const method = useDeflate ? 8 : 0

    const local = new Uint8Array(30)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, flags, true)
    lv.setUint16(8, method, true)
    lv.setUint16(10, dosTime(now), true)
    lv.setUint16(12, dosDate(now), true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, entry.data.length, true)
    lv.setUint16(26, name.length, true)
    parts.push(local, name, body)

    const cd = new Uint8Array(46)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20 | (3 << 8), true) // made by: unix-ish, so modes are carried (0644)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, flags, true)
    cv.setUint16(10, method, true)
    cv.setUint16(12, dosTime(now), true)
    cv.setUint16(14, dosDate(now), true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, entry.data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(38, 0o100644 << 16, true)
    cv.setUint32(42, offset, true)
    central.push(cd, name)
    offset += 30 + name.length + body.length
  }

  const cdSize = central.reduce((n, p) => n + p.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)

  const all = [...parts, ...central, end]
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of all) {
    out.set(p, at)
    at += p.length
  }
  return out
}
