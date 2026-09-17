// DMG Maker backend: prepares the artwork (background picture, volume icon) and drives lib/ (the
// pure-Node HFS+/UDIF writer). All heavy lifting happens in lib/, streamed, off the UI thread's back.
const path = require('node:path')
const fs = require('node:fs')
const { nativeImage } = require('electron')

// Finder draws the background from the top-left of the window's content area; the window frame
// stored in .DS_Store also includes the title bar.
const TITLE_BAR = 28

let lib = null
function dmg() {
  if (!lib) lib = require('./lib/index.cjs')
  return lib
}

/** @type {AbortController | null} */
let running = null

// ---------------------------------------------------------------- icns helpers

/** Largest PNG stored in an .icns, or null (old icons hold only RLE bitmaps). */
function largestPngInIcns(buf) {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'icns') return null
  let best = null
  for (let at = 8; at + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(at + 4)
    if (len < 8 || at + len > buf.length) break
    const data = buf.subarray(at + 8, at + len)
    if (data.length > 8 && data.readUInt32BE(0) === 0x89504e47 && (!best || data.length > best.length)) best = data
    at += len
  }
  return best
}

function icnsEntry(type, data) {
  const head = Buffer.alloc(8)
  head.write(type, 0, 'latin1')
  head.writeUInt32BE(8 + data.length, 4)
  return Buffer.concat([head, data])
}

/** Any picture → .icns (PNG entries; Icon Forge makes the full-compat version with legacy sizes). */
function imageToIcns(image) {
  const types = { 32: ['ic11'], 64: ['ic12'], 128: ['ic07'], 256: ['ic08', 'ic13'], 512: ['ic09', 'ic14'], 1024: ['ic10'] }
  const entries = []
  for (const [size, names] of Object.entries(types)) {
    const png = image.resize({ width: Number(size), height: Number(size), quality: 'best' }).toPNG()
    for (const name of names) entries.push(icnsEntry(name, png))
  }
  const body = Buffer.concat(entries)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'latin1')
  head.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([head, body])
}

/** The app's own icon file, when the source is a folder we can read directly. */
function appIconPath(source, info) {
  if (!info || info.kind !== 'app-folder' || !info.iconFile) return null
  const name = info.iconFile.endsWith('.icns') ? info.iconFile : info.iconFile + '.icns'
  const file = path.join(source, 'Contents', 'Resources', name)
  return fs.existsSync(file) ? file : null
}

// ---------------------------------------------------------------- artwork

/** Scale + crop the chosen picture to exactly the window's content size. */
function prepareBackground(file, width, height, fit, outDir) {
  const image = nativeImage.createFromPath(file)
  if (image.isEmpty()) throw new Error('That background picture could not be read (use PNG or JPG)')
  const size = image.getSize()
  let out
  if (fit === 'stretch') {
    out = image.resize({ width, height, quality: 'best' })
  } else {
    // cover: fill the window, crop the overflow equally on both sides
    const scale = Math.max(width / size.width, height / size.height)
    const w = Math.max(width, Math.round(size.width * scale))
    const h = Math.max(height, Math.round(size.height * scale))
    out = image.resize({ width: w, height: h, quality: 'best' }).crop({ x: Math.floor((w - width) / 2), y: Math.floor((h - height) / 2), width, height })
  }
  const target = path.join(outDir, 'background.png')
  fs.writeFileSync(target, out.toPNG())
  return target
}

function prepareVolumeIcon(choice, source, info, outDir) {
  if (!choice || choice.kind === 'none') return null
  if (choice.kind === 'app') return appIconPath(source, info)
  if (choice.kind === 'file' && choice.path) {
    if (choice.path.toLowerCase().endsWith('.icns')) return choice.path
    const image = nativeImage.createFromPath(choice.path)
    if (image.isEmpty()) throw new Error('That icon picture could not be read (use PNG, JPG or .icns)')
    const target = path.join(outDir, 'volume.icns')
    fs.writeFileSync(target, imageToIcns(image))
    return target
  }
  return null
}

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

// ---------------------------------------------------------------- handlers

module.exports = {
  async dispose() {
    running?.abort()
  },

  handlers: {
    async inspect({ source }, ctx) {
      if (!ctx.isAllowed(source)) throw new Error('Drop or choose the app first')
      const info = await dmg().inspectSource(source)
      let icon = null
      try {
        const file = appIconPath(source, info)
        const png = file ? largestPngInIcns(fs.readFileSync(file)) : null
        if (png) icon = 'data:image/png;base64,' + nativeImage.createFromBuffer(png).resize({ width: 256, height: 256, quality: 'best' }).toPNG().toString('base64')
      } catch {
        icon = null // the preview just falls back to a generic icon
      }
      return { ...info, icon, hasAppIcon: !!appIconPath(source, info) }
    },

    async build(args, ctx) {
      if (running) throw new Error('A DMG is already being built')
      const { source, outPath } = args
      if (!ctx.isAllowed(source)) throw new Error('Drop or choose the app first')
      if (!ctx.isAllowed(outPath)) throw new Error('Choose where to save the DMG first')

      const width = clampInt(args.window?.width, 320, 1600, 660)
      const height = clampInt(args.window?.height, 240, 1200, 400)
      const work = fs.mkdtempSync(path.join(ctx.tempDir(), 'build-'))
      const controller = new AbortController()
      running = controller
      const started = Date.now()
      try {
        const info = await dmg().inspectSource(source)
        const background = args.background?.path ? prepareBackground(args.background.path, width, height, args.background.fit, work) : null
        const volumeIcon = prepareVolumeIcon(args.volumeIcon, source, info, work)

        const result = await dmg().buildDmg(
          {
            source,
            outPath,
            volumeName: String(args.volumeName || '').trim() || undefined,
            applicationsLink: args.applicationsLink !== false,
            background,
            volumeIcon,
            window: { x: 200, y: 120, width, height: height + TITLE_BAR },
            iconSize: clampInt(args.iconSize, 32, 256, 128),
            textSize: clampInt(args.textSize, 10, 16, 13),
            appPosition: args.appPosition,
            applicationsPosition: args.applicationsPosition,
            compression: args.compression === 'none' ? 'none' : 'zlib',
            level: clampInt(args.level, 1, 9, 6),
            signal: controller.signal,
          },
          (progress) => ctx.emit('progress', progress),
        )
        const { manifest: _manifest, ...summary } = result
        return { ...summary, ms: Date.now() - started }
      } finally {
        running = null
        fs.rmSync(work, { recursive: true, force: true })
      }
    },

    async cancel() {
      running?.abort()
    },

    /** "Inspect an existing DMG": lists what is inside and re-checks its checksums. */
    async read({ path: file }, ctx) {
      if (!ctx.isAllowed(file)) throw new Error('Choose the DMG first')
      const result = await dmg().readDmg(file)
      return { volume: result.volume, checks: result.checks, entries: result.entries.slice(0, 5000), total: result.entries.length }
    },
  },
}
