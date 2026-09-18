// A hunt is a chain: START → stage 1 → stage 2 → … → finale. Every stage hides one message, and
// that message is written by the tool: the stage's own story line plus the pointer to the next stage
// (its file or page, and the password/keyword if it needs one). The maker only chooses how each stage
// hides things and writes the flavour text — the wiring between stages is never typed by hand.
//
// Two ways to play it:
//   files — one folder: START.txt next to the stage files; a "zip" stage swallows everything after it.
//   site  — a static website: every stage is a page at an unguessable address; START.txt holds the
//           first link; "gate" pages ask for a password and decrypt the next link in the browser.
import { drawQr, qrMatrix } from '@/lib/qr'
import { describeLayer, encodeAll, type Layer } from './ciphers'
import { lsbEmbed, pngAddText } from './stego'
import { textToWav } from './spectro'
import { buildZip } from './zip'

export type StageKind = 'cipher' | 'image' | 'audio' | 'zip' | 'gate' | 'qr' | 'folder'
export type CipherPreset = 'caesar' | 'vigenere' | 'base64' | 'morse' | 'invisible' | 'mix'
export type HuntMode = 'files' | 'site'

export interface Stage {
  id: string
  kind: StageKind
  title: string
  /** one or two lines of story revealed together with the pointer to the next stage */
  story: string
  /** the secret this stage guards: password (zip/gate), keyword (Vigenère); an audio stage spells the NEXT stage's word */
  word: string
  /** website address part, unguessable */
  slug: string
  cipher: CipherPreset
  imageMethod: 'lsb' | 'text' | 'both'
  coverPath: string | null
  decoys: number
  /** show a small hint line to the player */
  hint: boolean
}

export interface Chain {
  name: string
  mode: HuntMode
  siteUrl: string
  intro: string
  finale: { message: string; url: string; word: string; slug: string }
  stages: Stage[]
}

export const STAGE_KINDS: Array<{ kind: StageKind; label: string; blurb: string; siteOnly?: boolean }> = [
  { kind: 'cipher', label: 'Cipher', blurb: 'The clue is written in code.' },
  { kind: 'image', label: 'Picture', blurb: 'The clue is hidden inside a picture.' },
  { kind: 'audio', label: 'Sound', blurb: 'A word is drawn in the sound’s spectrogram. It spells the next stage’s word.' },
  { kind: 'zip', label: 'Locked zip', blurb: 'A password-protected archive. In a folder hunt it swallows everything after it.' },
  { kind: 'gate', label: 'Password page', blurb: 'A web page that asks for the password and then reveals the next link.', siteOnly: true },
  { kind: 'qr', label: 'QR code', blurb: 'The clue is a QR code.' },
  { kind: 'folder', label: 'Decoy maze', blurb: 'Dozens of junk files and folders; the clue is buried in the deepest one.' },
]

const WORDS = ['LANTERN', 'HOLLOW', 'ORBIT', 'MARROW', 'SIGNAL', 'ATTIC', 'EMBER', 'CIPHER', 'VESSEL', 'MIRROR', 'TUNNEL', 'STATIC', 'HARBOR', 'RELIC', 'NOVA', 'CINDER', 'FATHOM', 'GLASS', 'THRESHOLD', 'MERIDIAN', 'PARALLAX', 'SOLSTICE', 'ANCHOR', 'VELVET', 'QUARRY', 'SEPTEMBER', 'LATTICE', 'ECLIPSE', 'BASEMENT', 'COMPASS', 'CURTAIN', 'WICK']
export const randomWord = () => WORDS[Math.floor(Math.random() * WORDS.length)] + (Math.random() < 0.5 ? '' : String(10 + Math.floor(Math.random() * 89)))
export const randomSlug = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('')

let counter = 0
export function makeStage(kind: StageKind): Stage {
  return { id: `g${Date.now().toString(36)}${(counter++).toString(36)}`, kind, title: '', story: '', word: randomWord(), slug: randomSlug(), cipher: 'caesar', imageMethod: 'lsb', coverPath: null, decoys: 24, hint: true }
}

export function emptyChain(): Chain {
  return {
    name: 'Untitled hunt',
    mode: 'files',
    siteUrl: '',
    intro: 'Someone left this behind on purpose.\nEverything here means something.',
    finale: { message: 'You followed every thread. This was never meant to be found.', url: '', word: randomWord(), slug: randomSlug() },
    stages: [],
  }
}

/** Fills in anything an older saved hunt is missing. */
export function normalizeChain(raw: Partial<Chain> | undefined): Chain {
  const base = emptyChain()
  if (!raw || !Array.isArray(raw.stages)) return base
  return {
    ...base,
    ...raw,
    finale: { ...base.finale, ...(raw.finale ?? {}) },
    stages: raw.stages.map((s) => ({ ...makeStage(s.kind ?? 'cipher'), ...s })),
  }
}

export type Difficulty = 'easy' | 'medium' | 'hard'
export function preset(level: Difficulty, mode: HuntMode): Stage[] {
  const gate: StageKind = mode === 'site' ? 'gate' : 'zip'
  const plan: Array<[StageKind, Partial<Stage>]> =
    level === 'easy'
      ? [
          ['cipher', { cipher: 'caesar', title: 'The note', story: 'It started with this.' }],
          ['image', { imageMethod: 'text', title: 'The photo', story: 'Taken the night before.' }],
          ['zip', { title: 'The archive', story: 'What they tried to delete.' }],
        ]
      : level === 'medium'
        ? [
            ['image', { imageMethod: 'lsb', title: 'The photo', story: 'Nobody noticed the camera.' }],
            ['audio', { title: 'The recording' }],
            [gate, { title: 'Locked', story: 'Only one word opens this.' }],
            ['cipher', { cipher: 'vigenere', title: 'The letter', story: 'Written to be found.' }],
            ['qr', { title: 'The mark', story: 'You are nearly there.' }],
          ]
        : [
            ['cipher', { cipher: 'mix', title: 'The note', story: 'Three layers, like everything else.' }],
            ['image', { imageMethod: 'lsb', title: 'The photo', story: 'Look closer.' }],
            ['audio', { title: 'The recording' }],
            [gate, { title: 'Locked', story: 'You heard the word.' }],
            ['folder', { title: 'The drive', decoys: 60, story: 'Most of it was junk. Not all.' }],
            ['cipher', { cipher: 'vigenere', title: 'The letter', story: 'The keyword was in the drive.' }],
            ['qr', { title: 'The mark', story: 'Almost.' }],
            [gate, { title: 'The last door', story: 'This is the end of it.' }],
          ]
  return plan.map(([kind, extra]) => ({ ...makeStage(kind), ...extra }))
}

// ---------------------------------------------------------------- where things are and what they say

const enc = new TextEncoder()
const safe = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'file'
const EXT: Record<StageKind, string> = { cipher: 'txt', image: 'png', audio: 'wav', zip: 'zip', gate: 'html', qr: 'png', folder: 'txt' }
export const needsWord = (s: Stage) => s.kind === 'zip' || s.kind === 'gate' || (s.kind === 'cipher' && (s.cipher === 'vigenere' || s.cipher === 'mix'))
export const wordLabel = (s: Stage) => (s.kind === 'cipher' ? 'keyword' : 'password')
const afterAudio = (chain: Chain, i: number) => i > 0 && chain.stages[i - 1].kind === 'audio'
const siteRoot = (chain: Chain) => chain.siteUrl.trim().replace(/\/+$/, '') || '<your site>'

/** File name of stage i in a folder hunt. After a sound stage the file is named by the word the sound spells. */
export function fileNameOf(chain: Chain, i: number): string {
  const s = chain.stages[i]
  const named = afterAudio(chain, i) && !needsWord(s) ? s.word : safe(s.title || s.kind)
  return `${named}.${EXT[s.kind]}`
}
/** Address part of stage i in a website hunt. After a sound stage the address is the word the sound spells. */
export function slugOf(chain: Chain, i: number): string {
  const s = chain.stages[i]
  return afterAudio(chain, i) ? s.word.toLowerCase() : s.slug
}
const lastIsAudio = (chain: Chain) => chain.stages.length > 0 && chain.stages[chain.stages.length - 1].kind === 'audio'
export const finaleFile = (chain: Chain) => (lastIsAudio(chain) ? `${chain.finale.word}.html` : 'the end.html')
export const finaleSlug = (chain: Chain) => (lastIsAudio(chain) ? chain.finale.word.toLowerCase() : chain.finale.slug)

/** Where the player is told to go for stage i (or the finale when i is past the end). */
export function whereIs(chain: Chain, i: number): string {
  if (i >= chain.stages.length) return chain.mode === 'site' ? `${siteRoot(chain)}/${finaleSlug(chain)}/` : finaleFile(chain)
  return chain.mode === 'site' ? `${siteRoot(chain)}/${slugOf(chain, i)}/` : fileNameOf(chain, i)
}

/** The line that gets the player from stage i to stage i+1 (or to the finale). */
export function pointer(chain: Chain, i: number): string {
  const here = chain.stages[i]
  const next = chain.stages[i + 1] as Stage | undefined
  if (here.kind === 'audio') return next ? next.word : chain.finale.word // a spectrogram can only spell one word
  const go = chain.mode === 'site' ? `Go to ${whereIs(chain, i + 1)}` : `Open "${whereIs(chain, i + 1)}"`
  return next && needsWord(next) ? `${go}\n${wordLabel(next)}: ${next.word}` : go
}

/** The full hidden message of stage i: its story line, then the pointer. */
export function messageOf(chain: Chain, i: number): string {
  const s = chain.stages[i]
  if (s.kind === 'audio') return pointer(chain, i)
  return [s.story.trim(), pointer(chain, i)].filter(Boolean).join('\n\n')
}

/** The one thing the maker hands out. */
export function startNote(chain: Chain): string {
  const first = chain.stages[0] as Stage | undefined
  const go = chain.mode === 'site' ? `Go to ${whereIs(chain, 0)}` : first ? `Start with "${whereIs(chain, 0)}"` : `Open "${whereIs(chain, 0)}"`
  const to = first && needsWord(first) ? `${go}\n${wordLabel(first)}: ${first.word}` : go
  return [chain.intro.trim(), to].filter(Boolean).join('\n\n') + '\n'
}

export function layersFor(s: Stage): Layer[] {
  switch (s.cipher) {
    case 'caesar':
      return [{ kind: 'caesar', shift: 3 + (s.word.length % 9) }]
    case 'vigenere':
      return [{ kind: 'vigenere', key: s.word }]
    case 'base64':
      return [{ kind: 'base64' }]
    case 'morse':
      return [{ kind: 'morse' }]
    case 'invisible':
      return [{ kind: 'zerowidth', cover: s.story.trim() || 'Nothing to see here. Move along.' }]
    case 'mix':
      return [{ kind: 'vigenere', key: s.word }, { kind: 'base64' }, { kind: 'reverse' }]
  }
}

const CIPHER_HINT: Record<CipherPreset, string> = { caesar: 'shifted', vigenere: 'a keyword unlocks it', base64: 'sixty-four', morse: '. - .', mix: 'three layers deep', invisible: '' }

export function howSolved(s: Stage): string {
  switch (s.kind) {
    case 'cipher':
      return s.cipher === 'invisible' ? 'the text has invisible (zero-width) characters between the letters: paste it into the Decode tab or any zero-width decoder' : 'undo, in this order: ' + [...layersFor(s)].reverse().map(describeLayer).join(' → ')
    case 'image':
      return s.imageMethod === 'text' ? 'PNG metadata, field "Comment" (an EXIF viewer, `strings`, or the Decode tab)' : s.imageMethod === 'lsb' ? 'least-significant-bit steganography in the pixels (the Decode tab, or any LSB tool; the file must stay PNG)' : 'in the pixels (LSB) and also in the PNG metadata'
    case 'audio':
      return 'open the WAV in Audacity or Sonic Visualiser, switch to the spectrogram view, look between 2 and 8 kHz'
    case 'zip':
      return `extract it with the password "${s.word}"`
    case 'gate':
      return `type "${s.word}" on the page; the next link is decrypted in the browser (nothing readable in the page source)`
    case 'qr':
      return 'scan the QR code with a phone'
    case 'folder':
      return `search the ${s.decoys} junk files; the real note is the deepest one`
  }
}

export interface Hop {
  /** what the player has in hand at this point */
  at: string
  /** what the hidden message says */
  says: string
  /** how the player gets at it */
  how: string
  /** the secret the maker must not lose */
  key: string
}

export const kindLabel = (kind: StageKind) => STAGE_KINDS.find((k) => k.kind === kind)!.label

export function storyboard(chain: Chain): Hop[] {
  const hops: Hop[] = [{ at: 'START.txt — what you hand out', says: startNote(chain).trim(), how: 'read it', key: '' }]
  chain.stages.forEach((s, i) => {
    hops.push({
      at: `${i + 1}. ${s.title || kindLabel(s.kind)} — ${whereIs(chain, i)}`,
      says: messageOf(chain, i),
      how: howSolved(s),
      key: needsWord(s) ? `${wordLabel(s)} ${s.word}` : '',
    })
  })
  hops.push({ at: `Finale — ${whereIs(chain, chain.stages.length)}`, says: [chain.finale.message, chain.finale.url].filter(Boolean).join('\n'), how: 'open it', key: '' })
  return hops
}

export function solutionSheet(chain: Chain): string {
  const lines = [`SOLUTION — ${chain.name}`, 'For the maker only. Not part of the hunt.', '']
  storyboard(chain).forEach((h) => lines.push(h.at, `   says: ${h.says.replace(/\n+/g, ' / ')}`, `   how:  ${h.how}`, ...(h.key ? [`   key:  ${h.key}`] : []), ''))
  return lines.join('\n')
}

/** Things that would make the hunt unsolvable or silly, checked live in the editor. */
export function problems(chain: Chain): string[] {
  const out: string[] = []
  if (chain.mode === 'site' && !chain.siteUrl.trim()) out.push('Website hunts need the address the pages will live at (every clue says "go to <address>/…").')
  if (chain.mode === 'site' && chain.siteUrl.trim() && !/^https?:\/\//i.test(chain.siteUrl.trim())) out.push('The website address should start with https://')
  chain.stages.forEach((s, i) => {
    const name = `Stage ${i + 1}${s.title ? ` (${s.title})` : ''}`
    if (s.kind === 'gate' && chain.mode === 'files') out.push(`${name}: a password page only works in a website hunt. Use a locked zip instead.`)
    if (s.kind === 'audio' && chain.stages[i + 1]?.kind === 'audio') out.push(`${name}: two sound stages in a row cannot chain (a sound can only spell one word).`)
    if (needsWord(s) && !/^[A-Za-z0-9]{3,24}$/.test(s.word)) out.push(`${name}: the ${wordLabel(s)} should be 3–24 letters or digits, no spaces.`)
    if (s.kind === 'audio' && chain.stages[i + 1] && !/^[A-Za-z0-9]{2,12}$/.test(chain.stages[i + 1].word)) out.push(`${name}: the sound spells the next stage's word, which must be 2–12 letters or digits.`)
  })
  return out
}

// ---------------------------------------------------------------- building the files

export interface OutFile {
  path: string
  data: Uint8Array
}
export interface BuildContext {
  loadCover(path: string): Promise<ImageBitmap | null>
}
export interface BuildResult {
  files: OutFile[]
  startNote: string
  solution: string
  warnings: string[]
}

async function pngOf(canvas: OffscreenCanvas): Promise<Uint8Array> {
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
}

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
const LINES = ['the signal was stronger at night', 'nothing here. keep looking.', 'he said not to write it down', '03:14 — it happened again', 'checked the attic. empty.', 'do not trust the first one', 'the numbers repeat every seventh day', 'left this here in case', 'wrong folder', 'if you are reading this you are close', 'battery at 4%', 'they moved it', 'same dream. same door.', 'it was never about the key']

/** The decoy maze; the real note is in the deepest folder. */
function maze(s: Stage, message: string, root: string): OutFile[] {
  const r = rng(s.id + s.word)
  const dirs = [root]
  for (let d = 0; d < 3; d++) {
    const parent = dirs[Math.floor(r() * dirs.length)]
    for (let k = 0; k < 2 + Math.floor(r() * 2); k++) dirs.push(`${parent}/${DIRS[Math.floor(r() * DIRS.length)]}${r() < 0.3 ? ' ' + (1 + Math.floor(r() * 40)) : ''}`)
  }
  const unique = [...new Set(dirs)]
  const files: OutFile[] = []
  for (let k = 0; k < s.decoys; k++) {
    const n = 2 + Math.floor(r() * 4)
    const body = Array.from({ length: n }, () => LINES[Math.floor(r() * LINES.length)]).join('\n') + '\n'
    files.push({ path: `${unique[Math.floor(r() * unique.length)]}/${FILES[Math.floor(r() * FILES.length)].replace('.txt', r() < 0.4 ? ` ${1 + Math.floor(r() * 99)}.txt` : '.txt')}`, data: enc.encode(body) })
  }
  const deepest = unique.reduce((a, b) => (b.split('/').length > a.split('/').length ? b : a), unique[0])
  files.push({ path: `${deepest}/${safe(s.title || 'note')}.txt`, data: enc.encode(message + '\n') })
  return files
}

async function coverCanvas(bitmap: ImageBitmap | null, seed: string): Promise<OffscreenCanvas> {
  if (bitmap) {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
    const c = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
    c.getContext('2d')!.drawImage(bitmap, 0, 0, c.width, c.height)
    return c
  }
  const c = new OffscreenCanvas(960, 640)
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, 640)
  g.addColorStop(0, '#2a2f3a')
  g.addColorStop(1, '#0e1016')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 960, 640)
  const img = ctx.getImageData(0, 0, 960, 640)
  const r = rng(seed)
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r() - 0.5) * 28
    img.data[i] += n
    img.data[i + 1] += n
    img.data[i + 2] += n
  }
  ctx.putImageData(img, 0, 0)
  return c
}

interface Asset {
  name: string
  data: Uint8Array
}

/** The file a stage's clue is hidden in. A password page has none (the page itself is the stage). */
async function stageAsset(chain: Chain, i: number, ctx: BuildContext, warnings: string[]): Promise<Asset | null> {
  const s = chain.stages[i]
  const message = messageOf(chain, i)
  const base = fileNameOf(chain, i).replace(/\.[^.]+$/, '')
  switch (s.kind) {
    case 'cipher': {
      const encoded = encodeAll(message, layersFor(s))
      const body = s.hint && CIPHER_HINT[s.cipher] ? `${encoded}\n\n(${CIPHER_HINT[s.cipher]})\n` : encoded + '\n'
      return { name: `${base}.txt`, data: enc.encode(body) }
    }
    case 'image': {
      const canvas = await coverCanvas(s.coverPath ? await ctx.loadCover(s.coverPath) : null, s.id)
      const c2d = canvas.getContext('2d')!
      if (s.imageMethod !== 'text') {
        try {
          c2d.putImageData(lsbEmbed(c2d.getImageData(0, 0, canvas.width, canvas.height), message).pixels, 0, 0)
        } catch (err) {
          warnings.push(`${s.title || 'picture'}: ${(err as Error).message}`)
        }
      }
      let png = await pngOf(canvas)
      if (s.imageMethod !== 'lsb') png = pngAddText(png, 'Comment', message)
      return { name: `${base}.png`, data: png }
    }
    case 'audio':
      return { name: `${base}.wav`, data: textToWav({ text: message.slice(0, 24) }).wav }
    case 'qr': {
      const canvas = document.createElement('canvas')
      drawQr(canvas, qrMatrix(message, 'M'), 768, { margin: 4, fg: '#000000', bg: '#ffffff', rounded: false })
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
      return { name: `${base}.png`, data: new Uint8Array(await blob!.arrayBuffer()) }
    }
    case 'zip':
      return { name: `${base}.zip`, data: await buildZip([{ name: 'read me.txt', data: enc.encode(message + '\n') }], s.word) }
    case 'folder':
      return { name: `${base}.zip`, data: await buildZip(maze(s, message, safe(s.title || 'folder')).map((f) => ({ name: f.path, data: f.data }))) }
    case 'gate':
      return null
  }
}

// ---- website pages

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const PAGE_CSS = `body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07080b;color:#d9d9e0;font:17px/1.6 Georgia,serif}main{max-width:720px;padding:40px;text-align:center}h1{font-weight:normal;letter-spacing:.25em;text-transform:uppercase;font-size:13px;color:#6f7482;margin:0 0 28px}p{white-space:pre-wrap}img{max-width:100%;border-radius:6px;box-shadow:0 20px 60px #000}audio{width:100%;margin:12px 0}pre{text-align:left;white-space:pre-wrap;word-break:break-all;background:#0f1117;padding:18px;border-radius:6px;font-size:15px;user-select:text}a{color:#b9f24a}.hint{color:#5b606c;font-size:13px;margin-top:26px}input{font:inherit;padding:10px 14px;border-radius:6px;border:1px solid #333;background:#0f1117;color:#eee;width:60%}button{font:inherit;padding:10px 18px;border-radius:6px;border:0;background:#b9f24a;color:#111;margin-left:8px;cursor:pointer}.bad{color:#fb7185}iframe{width:100%;aspect-ratio:16/9;border:0;margin-top:28px;border-radius:8px;box-shadow:0 20px 60px #000}`
function page(title: string, body: string, chainName: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><main><h1>${esc(chainName)}</h1>${body}</main></body></html>`
}

const HINTS: Record<StageKind, string> = { cipher: 'It is written in code.', image: 'Look closer than the picture.', audio: 'Some things can only be seen, not heard.', zip: 'It is locked. You already have the key.', gate: 'You were told the word.', qr: 'Your phone knows.', folder: 'Most of these are lies.' }

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
export async function gateBlob(password: string, secret: string): Promise<{ salt: string; iv: string; data: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password.trim().toLowerCase()), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(secret)))
  return { salt: b64(salt), iv: b64(iv), data: b64(data) }
}
/** Same maths as the page runs; used by the self-test. */
export async function gateOpen(blob: { salt: string; iv: string; data: string }, password: string): Promise<string> {
  const b = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password.trim().toLowerCase()), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b(blob.salt), iterations: 120000, hash: 'SHA-256' }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b(blob.iv) }, key, b(blob.data)))
}

const GATE_JS = `async function go(){const p=document.getElementById('p').value;const b=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));const e=new TextEncoder();try{const k0=await crypto.subtle.importKey('raw',e.encode(p.trim().toLowerCase()),'PBKDF2',false,['deriveKey']);const k=await crypto.subtle.deriveKey({name:'PBKDF2',salt:b(G.salt),iterations:120000,hash:'SHA-256'},k0,{name:'AES-GCM',length:256},false,['decrypt']);const t=new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:b(G.iv)},k,b(G.data)));const h=t.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]);document.getElementById('out').innerHTML=h.replace(/(https?:\\/\\/[^\\s"<]+)/g,'<a href="$1">$1</a>').replace(/\\n/g,'<br>');document.getElementById('f').style.display='none'}catch(err){document.getElementById('bad').textContent='No.'}}document.getElementById('b').onclick=go;document.getElementById('p').onkeydown=e=>{if(e.key==='Enter')go()}`

async function stagePage(chain: Chain, i: number, asset: Asset | null): Promise<string> {
  const s = chain.stages[i]
  const story = s.kind === 'audio' || s.kind === 'cipher' ? '' : s.story.trim() // those two carry their story inside the clue
  const hint = s.hint ? `<p class="hint">${esc(HINTS[s.kind])}</p>` : ''
  let body = story ? `<p>${esc(story)}</p>` : ''
  if (s.kind === 'gate') {
    const g = await gateBlob(s.word, pointer(chain, i))
    body += `<div id="f"><input id="p" type="password" placeholder="password" autofocus><button id="b">Open</button><p id="bad" class="bad"></p></div><p id="out"></p><script>const G=${JSON.stringify(g)};${GATE_JS}</script>`
  } else if (asset) {
    if (s.kind === 'image') body += `<p><img src="${esc(asset.name)}" alt=""></p><p><a href="${esc(asset.name)}" download>download the picture</a></p>`
    else if (s.kind === 'audio') body += `<audio controls src="${esc(asset.name)}"></audio><p><a href="${esc(asset.name)}" download>download the recording</a></p>`
    else if (s.kind === 'cipher') body += `<pre>${esc(new TextDecoder().decode(asset.data))}</pre>`
    else if (s.kind === 'qr') body += `<p><img src="${esc(asset.name)}" alt="" style="max-width:360px;background:#fff;padding:12px"></p>`
    else body += `<p><a href="${esc(asset.name)}" download>${esc(asset.name)}</a></p>`
  }
  return page(s.title || 'untitled', body + hint, chain.name)
}

export const youtubeId = (url: string) => /(?:youtu\.be\/|v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/.exec(url)?.[1] ?? null

function finalePage(chain: Chain): string {
  const id = youtubeId(chain.finale.url)
  const url = chain.finale.url.trim()
  const body = `<p>${esc(chain.finale.message)}</p>${id ? `<iframe src="https://www.youtube.com/embed/${id}" allowfullscreen></iframe><p><a href="${esc(url)}">Open on YouTube</a></p>` : url ? `<p><a href="${esc(url)}">${esc(url)}</a></p>` : ''}`
  return page('the end', body, chain.name)
}

/**
 * Folder hunt:   START.txt, the stage files (a zip stage nests everything after it), the end.html
 * Website hunt:  START.txt, and site/ with one folder per stage (upload site/ anywhere static).
 */
export async function buildChain(chain: Chain, ctx: BuildContext): Promise<BuildResult> {
  const files: OutFile[] = []
  const warnings: string[] = []
  const start = startNote(chain)
  for (const p of problems(chain)) warnings.push(p)

  if (chain.mode === 'site') {
    files.push({ path: 'site/index.html', data: enc.encode(page('', '<p>There is nothing here.</p>', chain.name)) })
    for (let i = 0; i < chain.stages.length; i++) {
      const slug = slugOf(chain, i)
      const asset = await stageAsset(chain, i, ctx, warnings)
      if (asset) files.push({ path: `site/${slug}/${asset.name}`, data: asset.data })
      files.push({ path: `site/${slug}/index.html`, data: enc.encode(await stagePage(chain, i, asset)) })
    }
    files.push({ path: `site/${finaleSlug(chain)}/index.html`, data: enc.encode(finalePage(chain)) })
  } else {
    const build = async (from: number, into: OutFile[]): Promise<void> => {
      for (let i = from; i < chain.stages.length; i++) {
        const s = chain.stages[i]
        if (s.kind === 'gate') continue // already reported by problems()
        if (s.kind === 'zip') {
          const inner: OutFile[] = [{ path: 'read me.txt', data: enc.encode(messageOf(chain, i) + '\n') }]
          await build(i + 1, inner)
          into.push({ path: fileNameOf(chain, i), data: await buildZip(inner.map((f) => ({ name: f.path, data: f.data })), s.word) })
          return
        }
        if (s.kind === 'folder') {
          into.push(...maze(s, messageOf(chain, i), safe(s.title || 'folder')))
          continue
        }
        const asset = await stageAsset(chain, i, ctx, warnings)
        if (asset) into.push({ path: asset.name, data: asset.data })
      }
      into.push({ path: finaleFile(chain), data: enc.encode(finalePage(chain)) })
    }
    await build(0, files)
  }
  files.unshift({ path: 'START.txt', data: enc.encode(start) })

  const seen = new Set<string>()
  for (const f of files) {
    let p = f.path
    for (let k = 2; seen.has(p.toLowerCase()); k++) p = f.path.replace(/(\.[^./]*)?$/, ` (${k})$1`)
    f.path = p
    seen.add(p.toLowerCase())
  }
  return { files, startNote: start, solution: solutionSheet(chain), warnings }
}
