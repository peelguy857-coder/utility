// A trail is an ordered list of steps; each step hides its message somewhere and (usually) that
// message is what unlocks the next step. buildTrail() turns the list into the files to write, plus
// a solution sheet for the maker. A "zip" step wraps every step after it inside a locked archive.
import { drawQr, qrMatrix } from '@/lib/qr'
import { describeLayer, encodeAll, type Layer } from './ciphers'
import { lsbEmbed, pngAddText } from './stego'
import { textToWav } from './spectro'
import { buildZip } from './zip'

export type StepKind = 'note' | 'cipher' | 'image' | 'audio' | 'zip' | 'qr' | 'folder' | 'final'

interface StepBase {
  id: string
  kind: StepKind
  title: string
  /** The secret: the next password, the next location, or the final words. */
  message: string
  filename: string
}
export interface NoteStep extends StepBase {
  kind: 'note'
}
export interface CipherStep extends StepBase {
  kind: 'cipher'
  layers: Layer[]
  hint: string
}
export interface ImageStep extends StepBase {
  kind: 'image'
  coverPath: string | null
  method: 'lsb' | 'text' | 'both'
}
export interface AudioStep extends StepBase {
  kind: 'audio'
}
export interface ZipStep extends StepBase {
  kind: 'zip'
  password: string
}
export interface QrStep extends StepBase {
  kind: 'qr'
}
export interface FolderStep extends StepBase {
  kind: 'folder'
  decoys: number
  depth: number
  hidden: boolean
}
export interface FinalStep extends StepBase {
  kind: 'final'
  url: string
}
export type Step = NoteStep | CipherStep | ImageStep | AudioStep | ZipStep | QrStep | FolderStep | FinalStep

export interface Trail {
  name: string
  steps: Step[]
}

export const KINDS: Array<{ kind: StepKind; label: string; blurb: string }> = [
  { kind: 'note', label: 'Note', blurb: 'A plain text file — the opening message, or a hint.' },
  { kind: 'cipher', label: 'Cipher', blurb: 'The message encoded with one or more ciphers.' },
  { kind: 'image', label: 'Hidden in a picture', blurb: 'Invisible inside the pixels of a PNG, and/or in its metadata.' },
  { kind: 'audio', label: 'Hidden in a sound', blurb: 'A WAV whose spectrogram spells the message.' },
  { kind: 'zip', label: 'Locked zip', blurb: 'Everything after this step goes inside a password-protected zip.' },
  { kind: 'qr', label: 'QR code', blurb: 'The message as a QR image.' },
  { kind: 'folder', label: 'Decoy folders', blurb: 'A maze of folders and junk files with the real note buried inside.' },
  { kind: 'final', label: 'Final reveal', blurb: 'The page they end on: the message and your (unlisted) video link.' },
]

let counter = 0
const newId = () => `s${Date.now().toString(36)}${(counter++).toString(36)}`

export function makeStep(kind: StepKind): Step {
  const base = { id: newId(), title: KINDS.find((k) => k.kind === kind)!.label, message: '' }
  switch (kind) {
    case 'note':
      return { ...base, kind, filename: 'READ ME.txt', message: 'You found this. That means it has begun.\nLook closer at everything.' }
    case 'cipher':
      return { ...base, kind, filename: 'message.txt', layers: [{ kind: 'caesar', shift: 7 }], hint: '', message: 'the password is MIDNIGHT' }
    case 'image':
      return { ...base, kind, filename: 'photo.png', coverPath: null, method: 'lsb', message: 'look in the sound file' }
    case 'audio':
      return { ...base, kind, filename: 'recording.wav', message: 'OPEN THE ZIP' }
    case 'zip':
      return { ...base, kind, filename: 'archive.zip', password: 'MIDNIGHT', message: '' }
    case 'qr':
      return { ...base, kind, filename: 'scan-me.png', message: 'https://example.com' }
    case 'folder':
      return { ...base, kind, filename: 'the one that matters.txt', decoys: 24, depth: 3, hidden: false, message: 'you are close now' }
    case 'final':
      return { ...base, kind, filename: 'the end.html', url: '', message: 'You did it. Here is what you were looking for.' }
  }
}

export interface OutFile {
  path: string
  data: Uint8Array
}

export interface BuildContext {
  /** The picture for an image step, already decoded; null → a generated one is used. */
  loadCover(path: string): Promise<ImageBitmap | null>
}

export interface BuildResult {
  files: OutFile[]
  /** folders (relative) to mark hidden after writing */
  hiddenDirs: string[]
  solution: string
  warnings: string[]
}

const enc = new TextEncoder()
const safe = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'file'
const joinPath = (prefix: string, name: string) => (prefix ? `${prefix}/${name}` : name)

// ---------------------------------------------------------------- deterministic "random" for decoys

function rng(seed: string) {
  let h = 2166136261
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return () => {
    h ^= h << 13
    h ^= h >>> 17
    h ^= h << 5
    return ((h >>> 0) % 100000) / 100000
  }
}
const DIRS = ['old', 'backup', 'photos', '2019', 'misc', 'system', 'do not open', 'archive', 'temp', 'work', 'projects', 'downloads', 'private', 'logs', 'untitled folder', 'new folder (2)']
const FILES = ['readme.txt', 'notes.txt', 'todo.txt', 'log_0312.txt', 'draft.txt', 'ideas.txt', 'important.txt', 'untitled.txt', 'list.txt', 'session.txt', 'memo.txt', 'copy of notes.txt']
const LINES = [
  'the signal was stronger at night',
  'nothing here. keep looking.',
  'he said not to write it down',
  '03:14 — it happened again',
  'checked the attic. empty.',
  'do not trust the first one',
  'the numbers repeat every seventh day',
  'left this here in case',
  'wrong folder',
  'if you are reading this you are close',
  'battery at 4%',
  'they moved it',
  'same dream. same door.',
  'it was never about the key',
]

function decoyText(r: () => number): string {
  const n = 2 + Math.floor(r() * 4)
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(LINES[Math.floor(r() * LINES.length)])
  return out.join('\n') + '\n'
}

// ---------------------------------------------------------------- pictures

async function coverCanvas(bitmap: ImageBitmap | null, title: string): Promise<OffscreenCanvas> {
  if (bitmap) {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
    const c = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
    c.getContext('2d')!.drawImage(bitmap, 0, 0, c.width, c.height)
    return c
  }
  // a generated "found footage" frame: dark gradient, grain, a faint title
  const c = new OffscreenCanvas(960, 640)
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, 640)
  g.addColorStop(0, '#2a2f3a')
  g.addColorStop(1, '#0e1016')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 960, 640)
  const img = ctx.getImageData(0, 0, 960, 640)
  const r = rng(title)
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r() - 0.5) * 28
    img.data[i] += n
    img.data[i + 1] += n
    img.data[i + 2] += n
  }
  ctx.putImageData(img, 0, 0)
  ctx.fillStyle = 'rgba(255,255,255,0.08)'
  ctx.font = 'bold 42px Arial'
  ctx.fillText(title.toUpperCase(), 40, 590)
  return c
}

async function canvasPng(canvas: OffscreenCanvas): Promise<Uint8Array> {
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
}

function youtubeId(url: string): string | null {
  const m = /(?:youtu\.be\/|v=|\/shorts\/|\/embed\/)([\w-]{11})/.exec(url)
  return m ? m[1] : null
}

function finalHtml(step: FinalStep, trail: string): string {
  const id = youtubeId(step.url)
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(step.title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07080b;color:#e8e8ee;font:18px/1.6 Georgia,serif;text-align:center}
main{max-width:720px;padding:40px}h1{font-weight:normal;letter-spacing:.2em;text-transform:uppercase;font-size:16px;color:#8a8f9c;margin:0 0 24px}
p{white-space:pre-wrap}a{color:#b9f24a}iframe{width:100%;aspect-ratio:16/9;border:0;margin-top:28px;border-radius:8px;box-shadow:0 20px 60px #000}</style></head>
<body><main><h1>${esc(trail)}</h1><p>${esc(step.message)}</p>
${id ? `<iframe src="https://www.youtube.com/embed/${id}" allowfullscreen></iframe><p><a href="${esc(step.url)}">Open on YouTube</a></p>` : step.url ? `<p><a href="${esc(step.url)}">${esc(step.url)}</a></p>` : ''}
</main></body></html>`
}

// ---------------------------------------------------------------- the build

export async function buildTrail(trail: Trail, ctx: BuildContext): Promise<BuildResult> {
  const files: OutFile[] = []
  const hiddenDirs: string[] = []
  const warnings: string[] = []
  const lines: string[] = [`SOLUTION — ${trail.name}`, `Keep this file to yourself; it is not part of the trail.`, '']
  let n = 0

  /** Builds steps[from..] into `prefix`; returns the files produced (for zipping). */
  async function build(from: number, prefix: string, into: OutFile[]): Promise<void> {
    for (let i = from; i < trail.steps.length; i++) {
      const step = trail.steps[i]
      n++
      const name = safe(step.filename)
      const at = joinPath(prefix, name)
      const say = (how: string, answer?: string) => lines.push(`${n}. ${step.title}  [${KINDS.find((k) => k.kind === step.kind)!.label}]`, `   file: ${at}`, `   how:  ${how}`, ...(answer ? [`   answer: ${answer.replace(/\n/g, ' / ')}`] : []), '')

      switch (step.kind) {
        case 'note':
          into.push({ path: at, data: enc.encode(step.message) })
          say('just read it', step.message)
          break
        case 'cipher': {
          const encoded = encodeAll(step.message, step.layers)
          const body = step.hint ? `${encoded}\n\n(${step.hint})\n` : encoded + '\n'
          into.push({ path: at, data: enc.encode(body) })
          say(step.layers.length ? 'undo, in this order: ' + [...step.layers].reverse().map(describeLayer).join(' → ') : 'no cipher applied', step.message)
          break
        }
        case 'image': {
          const canvas = await coverCanvas(step.coverPath ? await ctx.loadCover(step.coverPath) : null, step.title)
          const c2d = canvas.getContext('2d')!
          let hows: string[] = []
          if (step.method === 'lsb' || step.method === 'both') {
            try {
              const { pixels } = lsbEmbed(c2d.getImageData(0, 0, canvas.width, canvas.height), step.message)
              c2d.putImageData(pixels, 0, 0)
              hows.push('the message is in the lowest bit of every pixel (LSB steganography) — extract with the Decode tab here or any LSB tool; the picture must stay a PNG')
            } catch (err) {
              warnings.push(`${step.title}: ${(err as Error).message}`)
            }
          }
          let png = await canvasPng(canvas)
          if (step.method === 'text' || step.method === 'both') {
            png = pngAddText(png, 'Comment', step.message)
            hows.push('the message is in a PNG text chunk ("Comment") — see it with an EXIF viewer, `strings`, or the Decode tab')
          }
          into.push({ path: at.replace(/\.[^.]*$/, '') + '.png', data: png })
          say(hows.join('; and ') || 'nothing hidden', step.message)
          break
        }
        case 'audio': {
          const { wav, seconds } = textToWav({ text: step.message })
          into.push({ path: at.replace(/\.[^.]*$/, '') + '.wav', data: wav })
          say(`open in Audacity / Sonic Visualiser and switch to the spectrogram view (2–8 kHz); the words appear after about 1 s (${seconds.toFixed(1)} s long)`, step.message)
          break
        }
        case 'qr': {
          const canvas = document.createElement('canvas')
          drawQr(canvas, qrMatrix(step.message, 'M'), 768, { margin: 4, fg: '#000000', bg: '#ffffff', rounded: false })
          into.push({ path: at.replace(/\.[^.]*$/, '') + '.png', data: new Uint8Array(await (await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png')))!.arrayBuffer()) })
          say('scan it with a phone camera', step.message)
          break
        }
        case 'folder': {
          const r = rng(step.id + step.title)
          const root = joinPath(prefix, safe(step.title))
          const dirs: string[] = [root]
          // a tree of decoy folders
          for (let d = 0; d < step.depth; d++) {
            const parent = dirs[Math.floor(r() * dirs.length)]
            for (let k = 0; k < 2 + Math.floor(r() * 2); k++) dirs.push(`${parent}/${DIRS[Math.floor(r() * DIRS.length)]}${r() < 0.3 ? ' ' + (1 + Math.floor(r() * 40)) : ''}`)
          }
          const unique = [...new Set(dirs)]
          for (let k = 0; k < step.decoys; k++) {
            const dir = unique[Math.floor(r() * unique.length)]
            into.push({ path: `${dir}/${FILES[Math.floor(r() * FILES.length)].replace('.txt', r() < 0.4 ? ` ${1 + Math.floor(r() * 99)}.txt` : '.txt')}`, data: enc.encode(decoyText(r)) })
          }
          const deepest = unique.reduce((a, b) => (b.split('/').length > a.split('/').length ? b : a), unique[0])
          const target = `${deepest}/${name}`
          into.push({ path: target, data: enc.encode(step.message + '\n') })
          if (step.hidden) hiddenDirs.push(root)
          say(`dig through the decoys (${step.decoys} junk files); the real one is ${target}${step.hidden ? ' — and the top folder is hidden: turn on "Show hidden items"' : ''}`, step.message)
          break
        }
        case 'zip': {
          const inner: OutFile[] = []
          await build(i + 1, '', inner)
          if (!inner.length) {
            warnings.push(`${step.title}: nothing comes after the zip, so it is empty`)
          }
          const zip = await buildZip(inner.map((f) => ({ name: f.path, data: f.data })), step.password || undefined)
          into.push({ path: at.replace(/\.[^.]*$/, '') + '.zip', data: zip })
          say(step.password ? `extract with the password "${step.password}" (${inner.length} file(s) inside)` : 'extract it (no password)', step.password)
          return // everything else lives inside the zip
        }
        case 'final': {
          into.push({ path: at.replace(/\.[^.]*$/, '') + '.html', data: enc.encode(finalHtml(step, trail.name)) })
          say('open it in a browser', step.url ? `${step.message} → ${step.url}` : step.message)
          break
        }
      }
    }
  }

  await build(0, '', files)
  // dedupe paths from careless naming
  const seen = new Set<string>()
  for (const f of files) {
    let p = f.path
    for (let k = 2; seen.has(p.toLowerCase()); k++) p = f.path.replace(/(\.[^./]*)?$/, ` (${k})$1`)
    f.path = p
    seen.add(p.toLowerCase())
  }
  return { files, hiddenDirs, solution: lines.join('\n'), warnings }
}

/** A complete example so the tool explains itself. */
export function exampleTrail(): Trail {
  const note = makeStep('note') as NoteStep
  note.title = 'The first note'
  note.message = 'Someone left this drive behind on purpose.\nEverything in here means something. Start with the photo.'
  const image = makeStep('image') as ImageStep
  image.title = 'The photo'
  image.message = 'the zip password is what you hear at 3 seconds'
  const audio = makeStep('audio') as AudioStep
  audio.title = 'A voice memo'
  audio.message = 'LANTERN'
  const zip = makeStep('zip') as ZipStep
  zip.title = 'Locked'
  zip.password = 'LANTERN'
  const cipher = makeStep('cipher') as CipherStep
  cipher.title = 'Scrambled note'
  cipher.layers = [{ kind: 'vigenere', key: 'LANTERN' }, { kind: 'base64' }]
  cipher.hint = 'the same word twice'
  cipher.message = 'go to the folder called work, then deeper than you think'
  const folder = makeStep('folder') as FolderStep
  folder.title = 'work'
  folder.message = 'the last piece is a QR code'
  const qr = makeStep('qr') as QrStep
  qr.title = 'Scan'
  qr.message = 'open the end'
  const final = makeStep('final') as FinalStep
  final.title = 'The end'
  final.message = 'You followed every thread. This was the video nobody was meant to find.'
  final.url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  return { name: 'The Drive', steps: [note, image, audio, zip, cipher, folder, qr, final] }
}
