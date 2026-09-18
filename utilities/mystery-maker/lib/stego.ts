// Hiding text in pictures: in the pixels (least significant bits — invisible, survives nothing but
// PNG) and in a PNG text chunk (found by anyone who runs `strings` or an EXIF viewer). Plus the
// readers for both, for the Decode tab.
import { crc32 } from './zip'

const MAGIC = new TextEncoder().encode('UTLY') // marks pixels that really carry a message

/** Bytes → bits into the low bit of every R, G and B value, left to right, top to bottom. */
export function lsbEmbed(pixels: ImageData, message: string): { pixels: ImageData; capacity: number; used: number } {
  const payload = new TextEncoder().encode(message)
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, payload.length)
  const bytes = new Uint8Array([...MAGIC, ...length, ...payload])
  const capacity = Math.floor((pixels.width * pixels.height * 3) / 8)
  if (bytes.length > capacity) throw new Error(`The picture can hide about ${capacity - 8} characters, this message is ${payload.length}`)
  const out = new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)
  const d = out.data
  let bit = 0
  for (let i = 0; i < d.length && bit < bytes.length * 8; i += 4) {
    for (let ch = 0; ch < 3 && bit < bytes.length * 8; ch++, bit++) {
      const b = (bytes[bit >> 3] >> (7 - (bit & 7))) & 1
      d[i + ch] = (d[i + ch] & 0xfe) | b
    }
  }
  return { pixels: out, capacity: capacity - 8, used: payload.length }
}

export function lsbExtract(pixels: ImageData): string | null {
  const d = pixels.data
  const read = (count: number, startBit: number) => {
    const out = new Uint8Array(count)
    let bit = startBit
    for (let n = 0; n < count * 8; n++, bit++) {
      const i = (bit / 3) | 0
      const ch = bit % 3
      const idx = i * 4 + ch
      if (idx >= d.length) return null
      out[n >> 3] = (out[n >> 3] << 1) | (d[idx] & 1)
    }
    return out
  }
  const head = read(8, 0)
  if (!head || head[0] !== MAGIC[0] || head[1] !== MAGIC[1] || head[2] !== MAGIC[2] || head[3] !== MAGIC[3]) return null
  const length = new DataView(head.buffer).getUint32(4)
  if (length > 10_000_000) return null
  const body = read(length, 64)
  return body ? new TextDecoder().decode(body) : null
}

// ---------------------------------------------------------------- PNG text chunks

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** Adds a `tEXt` chunk (keyword "Comment") right after IHDR. */
export function pngAddText(png: Uint8Array, keyword: string, text: string): Uint8Array {
  const enc = new TextEncoder()
  const data = new Uint8Array([...enc.encode(keyword.replace(/[^\x20-\x7e]/g, '').slice(0, 79) || 'Comment'), 0, ...enc.encode(text)])
  const extra = chunk('tEXt', data)
  const ihdrEnd = 8 + 12 + 13
  const out = new Uint8Array(png.length + extra.length)
  out.set(png.subarray(0, ihdrEnd))
  out.set(extra, ihdrEnd)
  out.set(png.subarray(ihdrEnd), ihdrEnd + extra.length)
  return out
}

/** Every text chunk in a PNG (tEXt and iTXt, uncompressed), keyword → text. */
export function pngReadText(png: Uint8Array): Array<{ keyword: string; text: string }> {
  const out: Array<{ keyword: string; text: string }> = []
  if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50) return out
  const dec = new TextDecoder()
  const latin = new TextDecoder('latin1')
  for (let at = 8; at + 12 <= png.length; ) {
    const len = new DataView(png.buffer, png.byteOffset + at, 4).getUint32(0)
    const type = latin.decode(png.subarray(at + 4, at + 8))
    const data = png.subarray(at + 8, at + 8 + len)
    if (type === 'tEXt') {
      const z = data.indexOf(0)
      if (z > 0) out.push({ keyword: latin.decode(data.subarray(0, z)), text: dec.decode(data.subarray(z + 1)) })
    } else if (type === 'iTXt') {
      const z = data.indexOf(0)
      if (z > 0 && data[z + 1] === 0) {
        let p = z + 3
        p = data.indexOf(0, p) + 1
        p = data.indexOf(0, p) + 1
        out.push({ keyword: latin.decode(data.subarray(0, z)), text: dec.decode(data.subarray(p)) })
      }
    }
    if (type === 'IEND') break
    at += 12 + len
  }
  return out
}
