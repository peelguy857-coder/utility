// Writers for the two icon container formats. Both just wrap images that were rendered elsewhere.

export interface IconImage {
  size: number
  png: Uint8Array
  /** Straight (non-premultiplied) RGBA pixels, row-major, top-down. */
  rgba: Uint8ClampedArray
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// ---------------------------------------------------------------- .ico (Windows)

/** 32-bit BMP payload as ICO wants it: BITMAPINFOHEADER with doubled height, BGRA bottom-up, then the 1-bit AND mask. */
function icoBitmap(img: IconImage): Uint8Array {
  const { size, rgba } = img
  const maskStride = Math.ceil(size / 32) * 4
  const out = new Uint8Array(40 + size * size * 4 + maskStride * size)
  const view = new DataView(out.buffer)
  view.setUint32(0, 40, true) // header size
  view.setInt32(4, size, true)
  view.setInt32(8, size * 2, true) // XOR image + AND mask
  view.setUint16(12, 1, true) // planes
  view.setUint16(14, 32, true) // bits per pixel
  view.setUint32(20, size * size * 4 + maskStride * size, true)
  let at = 40
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      out[at++] = rgba[i + 2]
      out[at++] = rgba[i + 1]
      out[at++] = rgba[i]
      out[at++] = rgba[i + 3]
    }
  }
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      if (rgba[(y * size + x) * 4 + 3] === 0) out[at + (x >> 3)] |= 0x80 >> (x & 7)
    }
    at += maskStride
  }
  return out
}

/** Sizes below 256 are stored as BMP (what every old tool and installer expects), 256 as PNG. */
export function buildIco(images: IconImage[]): Uint8Array {
  const sorted = [...images].sort((a, b) => a.size - b.size)
  const payloads = sorted.map((img) => (img.size >= 256 ? img.png : icoBitmap(img)))
  const header = new Uint8Array(6 + 16 * sorted.length)
  const view = new DataView(header.buffer)
  view.setUint16(2, 1, true) // type: icon
  view.setUint16(4, sorted.length, true)
  let offset = header.length
  sorted.forEach((img, i) => {
    const at = 6 + i * 16
    header[at] = img.size >= 256 ? 0 : img.size
    header[at + 1] = img.size >= 256 ? 0 : img.size
    view.setUint16(at + 4, 1, true) // planes
    view.setUint16(at + 6, 32, true) // bpp
    view.setUint32(at + 8, payloads[i].length, true)
    view.setUint32(at + 12, offset, true)
    offset += payloads[i].length
  })
  return concat([header, ...payloads])
}

// ---------------------------------------------------------------- .icns (macOS)

/** ICNS "RLE" for one channel. Literal runs only (valid, just not compressed) keeps this trivially correct. */
function icnsChannel(rgba: Uint8ClampedArray, channel: number): Uint8Array {
  const pixels = rgba.length / 4
  const out: number[] = []
  for (let start = 0; start < pixels; start += 128) {
    const count = Math.min(128, pixels - start)
    out.push(count - 1)
    for (let i = 0; i < count; i++) out.push(rgba[(start + i) * 4 + channel])
  }
  return Uint8Array.from(out)
}

const alphaChannel = (rgba: Uint8ClampedArray) => {
  const out = new Uint8Array(rgba.length / 4)
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4 + 3]
  return out
}

function icnsEntry(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length)
  for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i)
  new DataView(out.buffer).setUint32(4, out.length)
  out.set(data, 8)
  return out
}

// PNG-based types, by pixel size. @2x variants share the pixel data of the size they double.
const ICNS_PNG_TYPES: Record<number, string[]> = {
  32: ['ic11'], // 16@2x
  64: ['ic12'], // 32@2x
  128: ['ic07'],
  256: ['ic08', 'ic13'], // 256 and 128@2x
  512: ['ic09', 'ic14'], // 512 and 256@2x
  1024: ['ic10'], // 512@2x
}

export const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]

/**
 * 16 and 32 px are written in the legacy RGB+mask form (is32/s8mk, il32/l8mk), which every macOS
 * version draws correctly; everything larger is PNG.
 */
export function buildIcns(images: IconImage[]): Uint8Array {
  const bySize = new Map(images.map((img) => [img.size, img]))
  const entries: Uint8Array[] = []
  const legacy = (size: number, rgbType: string, maskType: string) => {
    const img = bySize.get(size)
    if (!img) return
    entries.push(icnsEntry(rgbType, concat([icnsChannel(img.rgba, 0), icnsChannel(img.rgba, 1), icnsChannel(img.rgba, 2)])))
    entries.push(icnsEntry(maskType, alphaChannel(img.rgba)))
  }
  legacy(16, 'is32', 's8mk')
  legacy(32, 'il32', 'l8mk')
  for (const [size, types] of Object.entries(ICNS_PNG_TYPES)) {
    const img = bySize.get(Number(size))
    if (img) for (const type of types) entries.push(icnsEntry(type, img.png))
  }
  const body = concat(entries)
  const header = new Uint8Array(8)
  header.set([0x69, 0x63, 0x6e, 0x73]) // 'icns'
  new DataView(header.buffer).setUint32(4, 8 + body.length)
  return concat([header, body])
}
