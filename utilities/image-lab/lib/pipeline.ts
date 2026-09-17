// Decode -> resample -> encode, all in the renderer. Decoding (createImageBitmap) and encoding
// (convertToBlob) run off the main thread; the drawing in between is split into steps that yield.
import { FORMAT_MIME, type OutFormat } from './options'
import { MAX_SIDE, type Plan } from './plan'

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg']

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
}
export const mimeForExt = (ext: string) => MIME[ext.toLowerCase()] ?? 'application/octet-stream'

/** Longest edge of the stand-in used for previews of very large images. */
const PROXY_EDGE = 2048

type Drawable = ImageBitmap | HTMLImageElement | OffscreenCanvas

export interface Source {
  /** 'svg' sources are vectors: drawn straight at the target size, never stepped down. */
  kind: 'bitmap' | 'svg'
  image: ImageBitmap | HTMLImageElement
  width: number
  height: number
  /** A smaller copy for previews (the image itself when it is small enough). */
  proxy: Drawable
  /** proxy pixels per source pixel (1 when proxy is the image). */
  proxyScale: number
  dispose: () => void
}

export const yieldToMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function context(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  // willReadFrequently keeps the canvas in CPU memory: no GPU texture limits, cheap encoding
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not create a drawing surface (out of memory?)')
  return ctx
}

function release(canvas: OffscreenCanvas | null) {
  if (canvas) canvas.width = canvas.height = 0
}

// ---------------------------------------------------------------- decode

export async function decodeSource(blob: Blob, isSvg: boolean): Promise<Source> {
  if (isSvg) {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    try {
      await img.decode()
    } catch {
      URL.revokeObjectURL(url)
      throw new Error('This SVG could not be drawn')
    }
    const width = img.naturalWidth || 512
    const height = img.naturalHeight || 512
    return { kind: 'svg', image: img, width, height, proxy: img, proxyScale: 1, dispose: () => URL.revokeObjectURL(url) }
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob) // honours EXIF rotation; GIF gives its first frame
  } catch {
    throw new Error('Not an image this app can decode')
  }
  const { width, height } = bitmap
  let proxy: Drawable = bitmap
  let proxyScale = 1
  const edge = Math.max(width, height)
  if (edge > PROXY_EDGE * 1.25) {
    proxyScale = PROXY_EDGE / edge
    const pw = Math.max(1, Math.round(width * proxyScale))
    const ph = Math.max(1, Math.round(height * proxyScale))
    const canvas = new OffscreenCanvas(pw, ph)
    await drawResampled(context(canvas), bitmap, false, 0, 0, width, height, 0, 0, pw, ph)
    proxy = canvas
  }
  return {
    kind: 'bitmap',
    image: bitmap,
    width,
    height,
    proxy,
    proxyScale,
    dispose: () => {
      bitmap.close()
      if (proxy instanceof OffscreenCanvas) release(proxy)
    },
  }
}

// ---------------------------------------------------------------- resample

/**
 * Draw a region of `image` into `ctx`. Big reductions are done by halving repeatedly (a 2x2 box
 * filter each time) so detail is averaged instead of skipped, which is what causes aliasing;
 * the last step (less than 2x) uses the browser's best filter.
 */
export async function drawResampled(
  ctx: OffscreenCanvasRenderingContext2D,
  image: Drawable,
  vector: boolean,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): Promise<void> {
  let cur: Drawable = image
  let scratch: OffscreenCanvas | null = null
  let cx = sx
  let cy = sy
  let cw = sw
  let ch = sh
  while (!vector && (cw > dw * 2 || ch > dh * 2)) {
    // only the axis that is still more than 2x too large gets halved (they differ in "stretch" mode)
    const nw = cw > dw * 2 ? Math.ceil(cw / 2) : Math.max(1, Math.round(cw))
    const nh = ch > dh * 2 ? Math.ceil(ch / 2) : Math.max(1, Math.round(ch))
    const next = new OffscreenCanvas(nw, nh)
    const nctx = context(next)
    nctx.imageSmoothingEnabled = true
    nctx.imageSmoothingQuality = 'low' // plain bilinear: at exactly 1/2 that is the average of each 2x2 block
    nctx.drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh)
    release(scratch)
    scratch = next
    cur = next
    cx = 0
    cy = 0
    cw = nw
    ch = nh
    await yieldToMain()
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(cur, cx, cy, cw, ch, dx, dy, dw, dh)
  release(scratch)
}

/**
 * Produce the planned image at `k` times its size (k < 1 for previews).
 * `fill` paints the background first (JPEG has no transparency); null keeps it transparent.
 */
export async function renderPlan(source: Source, plan: Plan, k: number, fill: string | null, preferProxy: boolean): Promise<OffscreenCanvas> {
  const outW = Math.max(1, Math.round(plan.outW * k))
  const outH = Math.max(1, Math.round(plan.outH * k))
  if (outW > MAX_SIDE || outH > MAX_SIDE) throw new Error(`${plan.outW} × ${plan.outH} is larger than the ${MAX_SIDE} px a canvas can hold`)
  const canvas = new OffscreenCanvas(outW, outH)
  const ctx = context(canvas)
  if (fill) {
    ctx.fillStyle = fill
    ctx.fillRect(0, 0, outW, outH)
  }
  const dx = Math.round(plan.dx * k)
  const dy = Math.round(plan.dy * k)
  const dw = plan.padded ? Math.max(1, Math.round(plan.dw * k)) : outW
  const dh = plan.padded ? Math.max(1, Math.round(plan.dh * k)) : outH

  // The proxy is good enough when it still has at least as many pixels as we are about to draw.
  const p = source.proxyScale
  const useProxy = preferProxy && p < 1 && plan.sw * p >= dw && plan.sh * p >= dh
  if (useProxy) await drawResampled(ctx, source.proxy, false, plan.sx * p, plan.sy * p, plan.sw * p, plan.sh * p, dx, dy, dw, dh)
  else await drawResampled(ctx, source.image, source.kind === 'svg', plan.sx, plan.sy, plan.sw, plan.sh, dx, dy, dw, dh)
  return canvas
}

// ---------------------------------------------------------------- encode

export function encode(canvas: OffscreenCanvas, format: OutFormat, quality: number): Promise<Blob> {
  return canvas.convertToBlob({ type: FORMAT_MIME[format], quality: format === 'png' ? undefined : Math.min(1, Math.max(0.01, quality / 100)) })
}

export interface Encoded {
  blob: Blob
  /** Quality actually used (may be lower than asked when a size limit applies). */
  quality: number
  /** False when even the lowest quality is above the limit (or the format is PNG and it is too big). */
  fits: boolean
  /** How many encodes it took. */
  tries: number
}

export const MIN_QUALITY = 5

/**
 * Encode at `quality`; when that is over `limit`, binary-search the highest quality that fits.
 * `stale()` lets the caller abandon the search early (returns null).
 */
export async function encodeToFit(canvas: OffscreenCanvas, format: OutFormat, quality: number, limit: number | null, stale: () => boolean = () => false): Promise<Encoded | null> {
  const first = await encode(canvas, format, quality)
  if (stale()) return null
  if (limit == null || first.size <= limit) return { blob: first, quality, fits: true, tries: 1 }
  if (format === 'png') return { blob: first, quality, fits: false, tries: 1 }

  let tries = 1
  let lo = MIN_QUALITY
  let hi = quality - 1
  let best: { blob: Blob; quality: number } | null = null
  let smallest: { blob: Blob; quality: number } = { blob: first, quality }
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const blob = await encode(canvas, format, mid)
    tries++
    if (stale()) return null
    if (blob.size < smallest.blob.size) smallest = { blob, quality: mid }
    if (blob.size <= limit) {
      best = { blob, quality: mid }
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (best) return { ...best, fits: true, tries }
  return { ...smallest, fits: false, tries }
}

// ---------------------------------------------------------------- small helpers

/** Small PNG for the queue list, as an object URL (revoke it when the item goes away). */
export async function makeThumbnail(source: Source, edge = 112): Promise<string> {
  const k = Math.min(1, edge / Math.max(source.width, source.height))
  const w = Math.max(1, Math.round(source.width * k))
  const h = Math.max(1, Math.round(source.height * k))
  const canvas = new OffscreenCanvas(w, h)
  const p = source.proxyScale
  await drawResampled(context(canvas), source.proxy, source.kind === 'svg', 0, 0, source.width * p, source.height * p, 0, 0, w, h)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  release(canvas)
  return URL.createObjectURL(blob)
}

/** Does any pixel let the background through? Checked on a reduced copy, which is plenty to notice. */
export async function detectAlpha(source: Source, ext: string): Promise<boolean> {
  if (ext === 'jpg' || ext === 'jpeg' || ext === 'bmp') return false
  const k = Math.min(1, 384 / Math.max(source.width, source.height))
  const w = Math.max(1, Math.round(source.width * k))
  const h = Math.max(1, Math.round(source.height * k))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = context(canvas)
  const p = source.proxyScale
  await drawResampled(ctx, source.proxy, source.kind === 'svg', 0, 0, source.width * p, source.height * p, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  let found = false
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) {
      found = true
      break
    }
  }
  release(canvas)
  return found
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image data'))
    reader.readAsDataURL(blob)
  })
}
