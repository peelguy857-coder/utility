// Text that only shows up in a spectrogram: the letters are drawn on a tiny canvas, then each column
// of that picture becomes a slice of time where every lit pixel is a sine tone at its row's
// frequency. Open the WAV in Audacity or Sonic Visualiser, switch to spectrogram view: there it is.

export interface SpectroOptions {
  text: string
  /** Hz range the picture occupies */
  low?: number
  high?: number
  /** seconds per character */
  perChar?: number
  sampleRate?: number
  /** a plain tone/noise before the message so the file sounds like "something" */
  intro?: boolean
}

const ROWS = 40

/** Render the text to a monochrome bitmap: [row][column] = lit */
function textBitmap(text: string): { width: number; rows: Uint8Array[] } {
  const canvas = new OffscreenCanvas(Math.max(1, text.length * 24 + 16), ROWS)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, ROWS)
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 30px Arial, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillText(text.toUpperCase(), 8, ROWS / 2 + 1)
  const img = ctx.getImageData(0, 0, canvas.width, ROWS).data
  const rows: Uint8Array[] = []
  for (let r = 0; r < ROWS; r++) {
    const row = new Uint8Array(canvas.width)
    for (let c = 0; c < canvas.width; c++) row[c] = img[(r * canvas.width + c) * 4] > 128 ? 1 : 0
    rows.push(row)
  }
  return { width: canvas.width, rows }
}

/** 16-bit mono WAV bytes with the text painted into its spectrogram. */
export function textToWav(opts: SpectroOptions): { wav: Uint8Array; seconds: number } {
  const sampleRate = opts.sampleRate ?? 44100
  const low = opts.low ?? 2000
  const high = opts.high ?? 8000
  const bitmap = textBitmap(opts.text)
  const perColumn = (opts.perChar ?? 0.45) / 24
  const columnSamples = Math.max(1, Math.round(perColumn * sampleRate))
  const introSamples = opts.intro === false ? 0 : Math.round(sampleRate * 1.2)
  const total = introSamples + bitmap.width * columnSamples + Math.round(sampleRate * 0.4)
  const samples = new Float32Array(total)

  // intro: a soft low hum so the clip does not start with pure silence
  for (let i = 0; i < introSamples; i++) samples[i] = 0.15 * Math.sin((2 * Math.PI * 110 * i) / sampleRate) * Math.min(1, i / 2000)

  const freqs = Array.from({ length: ROWS }, (_, r) => high - ((high - low) * r) / (ROWS - 1)) // row 0 = top = highest
  const phases = new Float64Array(ROWS)
  for (let c = 0; c < bitmap.width; c++) {
    const lit: number[] = []
    for (let r = 0; r < ROWS; r++) if (bitmap.rows[r][c]) lit.push(r)
    const gain = lit.length ? 0.6 / Math.sqrt(lit.length) : 0
    const start = introSamples + c * columnSamples
    for (let i = 0; i < columnSamples; i++) {
      let v = 0
      for (const r of lit) v += Math.sin(phases[r])
      samples[start + i] = v * gain
      for (const r of lit) phases[r] += (2 * Math.PI * freqs[r]) / sampleRate
    }
    // keep phases continuous for rows that stay lit, reset the rest so clicks stay quiet
    for (let r = 0; r < ROWS; r++) if (!bitmap.rows[r][c]) phases[r] = 0
  }

  const out = new Uint8Array(44 + total * 2)
  const v = new DataView(out.buffer)
  const str = (at: number, s: string) => [...s].forEach((ch, i) => (out[at + i] = ch.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + total * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, total * 2, true)
  for (let i = 0; i < total; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true)
  return { wav: out, seconds: total / sampleRate }
}

/** Mono float samples out of a 16-bit PCM WAV (first channel). */
export function wavToSamples(wav: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  if (String.fromCharCode(wav[0], wav[1], wav[2], wav[3]) !== 'RIFF') throw new Error('not a WAV file')
  let at = 12
  let channels = 1
  let sampleRate = 44100
  let bits = 16
  while (at + 8 <= wav.length) {
    const id = String.fromCharCode(wav[at], wav[at + 1], wav[at + 2], wav[at + 3])
    const size = v.getUint32(at + 4, true)
    if (id === 'fmt ') {
      channels = v.getUint16(at + 10, true)
      sampleRate = v.getUint32(at + 12, true)
      bits = v.getUint16(at + 22, true)
    } else if (id === 'data') {
      if (bits !== 16) throw new Error('only 16-bit WAV is supported here')
      const count = Math.floor(size / 2 / channels)
      const samples = new Float32Array(count)
      for (let i = 0; i < count; i++) samples[i] = v.getInt16(at + 8 + i * channels * 2, true) / 32768
      return { samples, sampleRate }
    }
    at += 8 + size + (size & 1)
  }
  throw new Error('no audio data in that WAV')
}

/** Draw a spectrogram (magnitude, log-ish) of the samples on a canvas. */
export function drawSpectrogram(canvas: HTMLCanvasElement, samples: Float32Array, sampleRate: number, maxHz = 10000) {
  const N = 1024
  const hop = Math.max(64, Math.floor(samples.length / 900))
  const columns = Math.max(1, Math.floor((samples.length - N) / hop))
  const bins = Math.min(N / 2, Math.floor((maxHz / sampleRate) * N))
  canvas.width = columns
  canvas.height = bins
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(columns, bins)
  const re = new Float32Array(N)
  const im = new Float32Array(N)
  const window = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)))
  for (let c = 0; c < columns; c++) {
    for (let i = 0; i < N; i++) {
      re[i] = samples[c * hop + i] * window[i]
      im[i] = 0
    }
    fft(re, im)
    for (let b = 0; b < bins; b++) {
      const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b]) / N
      const db = 20 * Math.log10(mag + 1e-7)
      const t = Math.max(0, Math.min(1, (db + 80) / 70))
      const y = bins - 1 - b
      const at = (y * columns + c) * 4
      img.data[at] = 20 + 235 * t
      img.data[at + 1] = 30 + 200 * t * t
      img.data[at + 2] = 60 + 60 * (1 - t)
      img.data[at + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
}

/** In-place radix-2 FFT. */
function fft(re: Float32Array, im: Float32Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j]
        const ui = im[i + j]
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr
        re[i + j] = ur + vr
        im[i + j] = ui + vi
        re[i + j + len / 2] = ur - vr
        im[i + j + len / 2] = ui - vi
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}
