// Drives the real Image Lab UI during `npm run shots -- image-lab`: generates fixture images,
// loads them through the dropzone's file dialog, changes options, exports, and checks the files.
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { nativeImage } = require('electron')

// ---------------------------------------------------------------- fixtures

const CRC = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, tail])
}
/** rgba: Buffer of width*height*4 */
function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 4 })), chunk('IEND', Buffer.alloc(0))])
}

let seed = 12345
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)

/** A photo-like picture: soft gradients, a few hard-edged discs and fine stripes (to reveal aliasing), plus grain. */
function paintPhoto(width, height, order /* 'rgba' | 'bgra' */) {
  const buf = Buffer.alloc(width * height * 4)
  const discs = [
    [0.25, 0.35, 0.18, [250, 190, 40]],
    [0.7, 0.55, 0.26, [40, 160, 230]],
    [0.52, 0.2, 0.1, [240, 80, 120]],
  ]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width
      const v = y / height
      let r = 30 + 120 * u + 40 * v
      let g = 40 + 150 * v
      let b = 90 + 110 * (1 - u)
      for (const [cx, cy, rad, col] of discs) {
        const dx = (u - cx) * (width / height)
        const dy = v - cy
        if (dx * dx + dy * dy < rad * rad) [r, g, b] = col
      }
      if (v > 0.8 && ((x >> 1) & 1)) {
        r *= 0.35
        g *= 0.35
        b *= 0.35
      }
      const n = (rand() - 0.5) * 22
      const i = (y * width + x) * 4
      const R = Math.max(0, Math.min(255, r + n))
      const G = Math.max(0, Math.min(255, g + n))
      const B = Math.max(0, Math.min(255, b + n))
      buf[i] = order === 'bgra' ? B : R
      buf[i + 1] = G
      buf[i + 2] = order === 'bgra' ? R : B
      buf[i + 3] = 255
    }
  }
  return buf
}

/** A logo on a transparent background. */
function paintLogo(size) {
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - size / 2
      const dy = y - size / 2
      const d = Math.sqrt(dx * dx + dy * dy)
      const i = (y * size + x) * 4
      if (d < size * 0.42) {
        const ring = d > size * 0.3
        buf[i] = ring ? 185 : 20
        buf[i + 1] = ring ? 242 : 24
        buf[i + 2] = ring ? 74 : 32
        buf[i + 3] = 255
      }
    }
  }
  return buf
}

// ---------------------------------------------------------------- reading results back

function dimensions(file) {
  const b = fs.readFileSync(file)
  if (b.readUInt32BE(0) === 0x89504e47) return { type: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i < b.length) {
      if (b[i] !== 0xff) throw new Error('bad JPEG marker')
      const marker = b[i + 1]
      const len = b.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { type: 'jpeg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5), bytes: b.length }
      i += 2 + len
    }
    throw new Error('no JPEG size found')
  }
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16)
    if (kind === 'VP8X') return { type: 'webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), bytes: b.length }
    if (kind === 'VP8 ') return { type: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, bytes: b.length }
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21)
      return { type: 'webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), bytes: b.length }
    }
  }
  throw new Error('unknown image type: ' + file)
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

// ---------------------------------------------------------------- the run

module.exports = async (t) => {
  const log = (...args) => console.log('[image-lab]', ...args)
  const root = path.join(t.tmpDir(), 'image-lab')
  fs.rmSync(root, { recursive: true, force: true })
  const out = path.join(root, 'out')
  fs.mkdirSync(out, { recursive: true })

  const photo = path.join(root, 'holiday photo.png')
  const logo = path.join(root, 'logo.png')
  const wide = path.join(root, 'banner-wide.png')
  const huge = path.join(root, 'huge-6000x4000.jpg')
  const notImage = path.join(root, 'notes.txt')
  fs.writeFileSync(photo, encodePng(1600, 1200, paintPhoto(1600, 1200, 'rgba')))
  fs.writeFileSync(logo, encodePng(640, 640, paintLogo(640)))
  fs.writeFileSync(wide, encodePng(2400, 800, paintPhoto(2400, 800, 'rgba')))
  fs.writeFileSync(notImage, 'not an image')

  const waitFor = async (js, label, timeout = 30000) => {
    const start = Date.now()
    for (;;) {
      const value = await t.exec(js)
      if (value) return value
      if (Date.now() - start > timeout) throw new Error('timed out waiting for ' + label)
      await t.sleep(100)
    }
  }
  const stats = () => t.exec(`(() => { const el = document.querySelector('.imglab__stats'); return el ? { ...el.dataset } : null })()`)
  const measured = async (width, height, label) => {
    await waitFor(
      `(() => { const d = document.querySelector('.imglab__stats')?.dataset; return !!d && d.phase === 'idle' && d.bytes !== '' && d.width === '${width}' && d.height === '${height}' })()`,
      `${label} (${width}x${height})`,
      60000,
    )
    return stats()
  }
  const clickExact = (text) =>
    t.exec(`(() => {
      const el = [...document.querySelectorAll('.keepalive:not([hidden]) .imglab button')].find((b) => b.offsetParent !== null && !b.disabled && (b.textContent || '').trim() === ${JSON.stringify(text)})
      if (!el) return false
      el.click()
      return true
    })()`)
  const must = async (promise, what) => assert(await promise, 'could not ' + what)
  const setSelect = (index, value) =>
    t.exec(`(() => {
      const el = document.querySelectorAll('.keepalive:not([hidden]) .imglab .workbench__side select')[${index}]
      if (!el) return false
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
  const toastText = () => t.exec(`[...document.querySelectorAll('.toast')].map((el) => el.textContent).join(' | ')`)
  const fileReady = async (file, label) => {
    const start = Date.now()
    while (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      if (Date.now() - start > 60000) throw new Error('never written: ' + label)
      await t.sleep(100)
    }
    await t.sleep(150)
  }

  // ---- a file that is not an image is refused with a message, not silently
  t.queuePick([notImage])
  await must(t.clickText('Browse'), 'click Browse')
  await waitFor(`[...document.querySelectorAll('.toast')].some((el) => /not an image/.test(el.textContent))`, 'the "not an image" toast')

  // ---- load one image through the real dialog path
  t.queuePick([photo])
  await must(t.clickText('Browse'), 'click Browse')
  let s = await measured(1600, 1200, 'first measurement')
  log('loaded 1600x1200 PNG ->', s.bytes, 'bytes as PNG')
  await t.capture('loaded')

  // ---- YouTube thumbnail preset: 1280x720, cover, JPEG, max 2 MB
  await must(setSelect(0, 'yt-thumbnail'), 'choose the YouTube preset')
  s = await measured(1280, 720, 'YouTube preset')
  assert(s.fits === 'true', 'YouTube preset result should fit 2 MB')
  const fullQualityBytes = Number(s.bytes)
  log('YouTube thumbnail:', s.bytes, 'bytes at quality', s.quality)
  await t.capture('youtube-preset')

  const thumb = path.join(out, 'thumb.jpg')
  t.queuePick([thumb])
  await must(clickExact('Export…'), 'click Export')
  await fileReady(thumb, 'thumb.jpg')
  let d = dimensions(thumb)
  assert(d.type === 'jpeg' && d.width === 1280 && d.height === 720, `thumb.jpg is ${d.type} ${d.width}x${d.height}`)
  assert(d.bytes <= 2 * 1024 * 1024, 'thumb.jpg is over 2 MB')
  assert(d.bytes === fullQualityBytes, `exported bytes (${d.bytes}) differ from the measured size shown (${fullQualityBytes})`)

  // ---- squeeze: a limit of 40 % of that forces the binary search
  const limitKb = Math.floor((fullQualityBytes * 0.4) / 1024)
  await must(setSelect(1, 'KB'), 'switch the limit to KB')
  await must(t.setInput('.imglab .workbench__side .panel:nth-of-type(2) .input--number input', String(limitKb)), 'type the limit')
  await waitFor(`(() => { const d = document.querySelector('.imglab__stats')?.dataset; return !!d && d.phase === 'idle' && d.bytes !== '' && Number(d.bytes) <= ${limitKb * 1024} })()`, 'the squeezed measurement', 60000)
  s = await stats()
  assert(s.fits === 'true' && Number(s.quality) < 90, `expected a lowered quality, got ${s.quality}`)
  log(`limit ${limitKb} KB -> quality ${s.quality}, ${s.bytes} bytes`)
  await t.capture('squeezed')
  const squeezed = path.join(out, 'squeezed.jpg')
  t.queuePick([squeezed])
  await must(clickExact('Export…'), 'click Export')
  await fileReady(squeezed, 'squeezed.jpg')
  d = dimensions(squeezed)
  assert(d.width === 1280 && d.height === 720 && d.bytes <= limitKb * 1024, `squeezed.jpg is ${d.bytes} bytes, limit ${limitKb * 1024}`)

  // ---- a limit nothing can reach
  await must(t.setInput('.imglab .workbench__side .panel:nth-of-type(2) .input--number input', '2'), 'type a 2 KB limit')
  await waitFor(`document.querySelector('.imglab__stats')?.dataset.fits === 'false' && document.querySelector('.imglab__stats')?.dataset.phase === 'idle'`, 'the cannot-fit state', 60000)
  assert(/Cannot get under/.test(await t.text('.imglab .notice')), 'no "cannot fit" notice')
  await t.capture('cannot-fit')

  // ---- PNG cannot be squeezed: warning + one-click switch to WebP
  await must(clickExact('PNG'), 'choose PNG')
  await waitFor(`/PNG cannot be squeezed/.test(document.querySelector('.imglab .notice')?.textContent || '')`, 'the PNG warning', 60000)
  await t.capture('png-limit')
  await must(clickExact('Switch to WebP'), 'click Switch to WebP')
  await waitFor(`[...document.querySelectorAll('.imglab .segmented__item.is-active')].some((b) => b.textContent.trim() === 'WebP')`, 'WebP to become active')

  // ---- crop marks on the original (Steam vertical capsule crops a lot of a 4:3 photo)
  await must(setSelect(0, 'steam-vertical'), 'choose the Steam vertical preset')
  await measured(748, 896, 'Steam vertical')
  await must(clickExact('Original'), 'show the original')
  await t.sleep(400)
  assert(await t.exec(`!!document.querySelector('.imglab__crop')`), 'no crop marks on the original')
  await t.capture('crop-marks')
  await must(clickExact('Compare'), 'back to compare')

  // ---- batch: add two more, web-friendly preset, export into a folder
  t.queuePick([logo, wide, photo]) // photo again: must be ignored as a repeat
  await must(clickExact('Add images'), 'click Add images')
  await waitFor(`document.querySelectorAll('.imglab__row').length === 3`, 'three queue rows')
  await must(setSelect(0, 'web'), 'choose the web preset')
  await measured(1600, 1200, 'web preset on the photo')
  await t.capture('batch')
  t.queuePick([out])
  await must(clickExact('Export 3 images'), 'click Export 3 images')
  await waitFor(`document.querySelectorAll('.imglab__row[data-status="done"]').length === 3`, 'three saved rows', 90000)
  const expectBatch = { 'holiday photo-1600x1200.webp': [1600, 1200], 'logo-640x640.webp': [640, 640], 'banner-wide-1920x640.webp': [1920, 640] }
  for (const [file, [w, h]] of Object.entries(expectBatch)) {
    const full = path.join(out, file)
    assert(fs.existsSync(full), 'batch output missing: ' + file)
    d = dimensions(full)
    assert(d.type === 'webp' && d.width === w && d.height === h, `${file} is ${d.type} ${d.width}x${d.height}`)
  }
  log('batch toast:', await toastText())
  await t.capture('batch-done')

  // exporting the same batch again must not overwrite anything
  await must(clickExact('Export 3 images'), 'export the batch again')
  await waitFor(`/Exported 3 images/.test([...document.querySelectorAll('.toast')].at(-1)?.textContent || '') && document.querySelectorAll('.imglab__row[data-status="done"]').length === 3 && !document.querySelector('.imglab__exporting')`, 'second batch export', 90000)
  await t.sleep(300)
  assert(fs.existsSync(path.join(out, 'logo-640x640-2.webp')), 'second export should have been numbered, not overwritten')

  // ---- Discord emoji from the transparent logo: exactly 128x128 PNG under 256 KB
  await t.exec(`[...document.querySelectorAll('.imglab__rowmain')].find((b) => /logo\\.png/.test(b.textContent))?.click()`)
  await must(setSelect(0, 'discord-emoji'), 'choose the Discord emoji preset')
  await measured(128, 128, 'Discord emoji')
  await t.capture('emoji')
  const emoji = path.join(out, 'emoji.png')
  t.queuePick([emoji])
  await must(clickExact('Save this one…'), 'click Save this one')
  await fileReady(emoji, 'emoji.png')
  d = dimensions(emoji)
  assert(d.type === 'png' && d.width === 128 && d.height === 128 && d.bytes <= 256 * 1024, `emoji.png is ${d.type} ${d.width}x${d.height} ${d.bytes} B`)

  // JPEG from a transparent source offers the background colour
  await must(clickExact('JPEG'), 'choose JPEG')
  await waitFor(`/Background/.test(document.querySelector('.imglab .workbench__side')?.textContent || '')`, 'the background option')

  // ---- the same screen in the light theme and at the minimum window size
  await must(setSelect(0, 'yt-thumbnail'), 'choose the YouTube preset')
  await t.exec(`[...document.querySelectorAll('.imglab__rowmain')].find((b) => /holiday/.test(b.textContent))?.click()`)
  await measured(1280, 720, 'YouTube preset again')
  t.win.webContents.send('core:command', 'theme', 'light')
  await t.sleep(700)
  await t.capture('light')
  t.win.setSize(940, 600)
  await t.sleep(900)
  const overflow = await t.exec(`(() => { const m = document.querySelector('.main'); return m.scrollWidth - m.clientWidth })()`)
  assert(overflow <= 0, `the page overflows sideways by ${overflow}px at 940x600`)
  await t.capture('min-size-light')
  await t.exec(`document.querySelector('.main').scrollTo(0, 99999)`)
  await t.sleep(300)
  await t.capture('min-size-light-bottom')
  t.win.webContents.send('core:command', 'theme', 'dark')
  await t.sleep(500)
  await t.exec(`document.querySelector('.main').scrollTo(0, 0)`)
  await t.sleep(300)
  await t.capture('min-size-dark')
  t.win.setSize(1220, 800)
  await t.sleep(700)

  // ---- a 24-megapixel photo must not freeze the window
  log('building the 6000x4000 JPEG…')
  fs.writeFileSync(huge, nativeImage.createFromBitmap(paintPhoto(6000, 4000, 'bgra'), { width: 6000, height: 4000 }).toJPEG(90))
  log('huge fixture:', fs.statSync(huge).size, 'bytes')
  await must(clickExact('Clear'), 'clear the queue')
  await waitFor(`!!document.querySelector('.imglab .dropzone')`, 'the empty state')
  await t.exec(`(() => {
    const p = (window.__probe = { max: 0, last: performance.now(), on: true, over: 0 })
    const tick = () => { const now = performance.now(); const gap = now - p.last; if (gap > p.max) p.max = gap; if (gap > 120) p.over++; p.last = now; if (p.on) setTimeout(tick, 5) }
    tick()
  })()`)
  const started = Date.now()
  t.queuePick([huge])
  await must(t.clickText('Browse'), 'click Browse')
  await measured(1280, 720, 'YouTube preset on the huge photo')
  log('huge: loaded + previewed + measured in', Date.now() - started, 'ms')
  await must(setSelect(0, 'custom'), 'custom')
  await must(clickExact('Keep'), 'keep size')
  s = await measured(6000, 4000, 'full-size JPEG of the huge photo')
  const probe = await t.exec(`(() => { window.__probe.on = false; return { max: Math.round(window.__probe.max), over: window.__probe.over } })()`)
  log(`huge: full-size re-encode measured (${s.bytes} bytes); longest main-thread stall ${probe.max} ms, stalls over 120 ms: ${probe.over}; total ${Date.now() - started} ms`)
  assert(probe.max < 700, `the UI froze for ${probe.max} ms while handling the 6000x4000 photo`)
  await t.capture('huge')
  await must(setSelect(0, 'yt-thumbnail'), 'YouTube preset')
  await measured(1280, 720, 'YouTube preset on the huge photo (again)')
  const hugeOut = path.join(out, 'huge-thumb.jpg')
  t.queuePick([hugeOut])
  await must(clickExact('Export…'), 'click Export')
  await fileReady(hugeOut, 'huge-thumb.jpg')
  d = dimensions(hugeOut)
  assert(d.width === 1280 && d.height === 720 && d.bytes <= 2 * 1024 * 1024, `huge-thumb.jpg is ${d.width}x${d.height} ${d.bytes} B`)
  await t.capture('huge-exported')
  log('all image-lab checks passed; outputs in', out)
}
