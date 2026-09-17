// Turns one source picture into a square 1024px "master" and then into every size an icon needs.
import type { IconImage } from './containers'

export type Shape = 'none' | 'rounded' | 'circle' | 'macos'

export interface MasterOptions {
  shape: Shape
  /** Empty border around the artwork, 0-40 (% of the canvas). */
  padding: number
  /** CSS colour, or null for transparent. */
  background: string | null
  /** How the artwork fills its box when it is not square. */
  fit: 'contain' | 'cover'
}

export const MASTER = 1024

export async function loadBitmap(bytes: Uint8Array, ext: string): Promise<ImageBitmap> {
  const type = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
  const blob = new Blob([bytes as BlobPart], { type })
  if (ext !== 'svg') return createImageBitmap(blob)
  // SVGs have no pixel size of their own: rasterise them big via an <img>.
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const w = img.naturalWidth || MASTER
    const h = img.naturalHeight || MASTER
    const scale = (MASTER * 2) / Math.max(w, h)
    const canvas = new OffscreenCanvas(Math.round(w * scale), Math.round(h * scale))
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.transferToImageBitmap()
  } finally {
    URL.revokeObjectURL(url)
  }
}

function shapePath(ctx: OffscreenCanvasRenderingContext2D, shape: Shape, x: number, y: number, size: number) {
  ctx.beginPath()
  if (shape === 'circle') ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2)
  else if (shape === 'rounded') ctx.roundRect(x, y, size, size, size * 0.18)
  else if (shape === 'macos') ctx.roundRect(x, y, size, size, size * 0.225) // Apple's grid: 185px radius on an 824px tile
  else ctx.rect(x, y, size, size)
}

export function renderMaster(source: ImageBitmap, opts: MasterOptions): OffscreenCanvas {
  const canvas = new OffscreenCanvas(MASTER, MASTER)
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // macOS icons sit on an 824px tile inside the 1024 canvas, with a soft shadow underneath.
  const tile = opts.shape === 'macos' ? 824 : MASTER
  const tileX = (MASTER - tile) / 2
  const tileY = (MASTER - tile) / 2

  if (opts.shape === 'macos') {
    ctx.save()
    ctx.shadowColor = 'rgb(0 0 0 / 0.3)'
    ctx.shadowBlur = 28
    ctx.shadowOffsetY = 12
    ctx.fillStyle = opts.background ?? '#ffffff'
    shapePath(ctx, 'macos', tileX, tileY, tile)
    ctx.fill()
    ctx.restore()
  }

  ctx.save()
  shapePath(ctx, opts.shape, tileX, tileY, tile)
  ctx.clip()
  if (opts.background) {
    ctx.fillStyle = opts.background
    ctx.fillRect(tileX, tileY, tile, tile)
  }
  const box = tile * (1 - (opts.padding * 2) / 100)
  const ratio = opts.fit === 'cover' ? Math.max(box / source.width, box / source.height) : Math.min(box / source.width, box / source.height)
  const w = source.width * ratio
  const h = source.height * ratio
  if (opts.fit === 'cover') {
    // crop to the padded box, not to the whole tile
    ctx.beginPath()
    ctx.rect(tileX + (tile - box) / 2, tileY + (tile - box) / 2, box, box)
    ctx.clip()
  }
  ctx.drawImage(source, MASTER / 2 - w / 2, MASTER / 2 - h / 2, w, h)
  ctx.restore()
  return canvas
}

/** Halve repeatedly, then do the last step directly: avoids the shimmer a single big downscale gives. */
function downscale(master: OffscreenCanvas, size: number): OffscreenCanvas {
  let current: OffscreenCanvas = master
  while (current.width / 2 >= size * 1.5) {
    const next = new OffscreenCanvas(current.width / 2, current.height / 2)
    const ctx = next.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(current, 0, 0, next.width, next.height)
    current = next
  }
  if (current.width === size) return current
  const out = new OffscreenCanvas(size, size)
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(current, 0, 0, size, size)
  return out
}

export async function renderSize(master: OffscreenCanvas, size: number, opaque?: string): Promise<IconImage> {
  let canvas = downscale(master, size)
  if (opaque) {
    const flat = new OffscreenCanvas(size, size)
    const ctx = flat.getContext('2d')!
    ctx.fillStyle = opaque
    ctx.fillRect(0, 0, size, size)
    ctx.drawImage(canvas, 0, 0)
    canvas = flat
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const png = new Uint8Array(await blob.arrayBuffer())
  const rgba = canvas.getContext('2d')!.getImageData(0, 0, size, size).data
  return { size, png, rgba }
}
