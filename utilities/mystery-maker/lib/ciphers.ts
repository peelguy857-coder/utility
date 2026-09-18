// The classic ARG cipher toolbox: every encoder has a decoder, and autoDecode() tries them all.

export type Layer =
  | { kind: 'caesar'; shift: number }
  | { kind: 'rot13' }
  | { kind: 'atbash' }
  | { kind: 'a1z26' }
  | { kind: 'vigenere'; key: string }
  | { kind: 'base64' }
  | { kind: 'hex' }
  | { kind: 'binary' }
  | { kind: 'morse' }
  | { kind: 'reverse' }
  | { kind: 'zerowidth'; cover: string }

export const LAYER_KINDS: Array<{ kind: Layer['kind']; label: string; hint: string }> = [
  { kind: 'caesar', label: 'Caesar shift', hint: 'Every letter moved N places along the alphabet.' },
  { kind: 'rot13', label: 'ROT13', hint: 'Caesar with shift 13; applying it twice gets the text back.' },
  { kind: 'atbash', label: 'Atbash', hint: 'A↔Z, B↔Y, C↔X …' },
  { kind: 'a1z26', label: 'A1Z26', hint: 'Letters become their position: A=1, B=2 … Z=26.' },
  { kind: 'vigenere', label: 'Vigenère', hint: 'Caesar with a keyword that changes the shift per letter.' },
  { kind: 'base64', label: 'Base64', hint: 'The classic “looks like random letters ending in =”.' },
  { kind: 'hex', label: 'Hex', hint: 'Bytes as 48 65 6c 6c 6f.' },
  { kind: 'binary', label: 'Binary', hint: 'Bytes as 01001000 01101001.' },
  { kind: 'morse', label: 'Morse', hint: '.... . .-.. .-.. --- with / between words.' },
  { kind: 'reverse', label: 'Reversed', hint: 'Written backwards.' },
  { kind: 'zerowidth', label: 'Invisible ink', hint: 'Hidden in zero-width characters inside an innocent cover text. Invisible unless you look for it.' },
]

const utf8 = new TextEncoder()
const utf8d = new TextDecoder()

const shiftLetters = (text: string, shiftAt: (i: number) => number) => {
  let letterIndex = 0
  return text.replace(/[A-Za-z]/g, (ch) => {
    const base = ch <= 'Z' ? 65 : 97
    const s = ((shiftAt(letterIndex++) % 26) + 26) % 26
    return String.fromCharCode(((ch.charCodeAt(0) - base + s) % 26) + base)
  })
}

export const caesar = (text: string, shift: number) => shiftLetters(text, () => shift)
export const atbash = (text: string) => text.replace(/[A-Za-z]/g, (ch) => (ch <= 'Z' ? String.fromCharCode(155 - ch.charCodeAt(0)) : String.fromCharCode(219 - ch.charCodeAt(0))))

export function vigenere(text: string, key: string, decode = false): string {
  const k = key.toUpperCase().replace(/[^A-Z]/g, '')
  if (!k) return text
  return shiftLetters(text, (i) => (k.charCodeAt(i % k.length) - 65) * (decode ? -1 : 1))
}

export const a1z26 = (text: string) =>
  text
    .split(/\s+/)
    .map((w) => [...w.toUpperCase()].filter((c) => /[A-Z]/.test(c)).map((c) => c.charCodeAt(0) - 64).join('-'))
    .filter(Boolean)
    .join(' ')
export const a1z26Decode = (text: string) =>
  text
    .trim()
    .split(/\s+/)
    .map((w) => w.split(/[-.,]/).map((n) => (Number(n) >= 1 && Number(n) <= 26 ? String.fromCharCode(64 + Number(n)) : '?')).join(''))
    .join(' ')

export const base64 = (text: string) => btoa(String.fromCharCode(...utf8.encode(text)))
export const base64Decode = (text: string) => utf8d.decode(Uint8Array.from(atob(text.trim().replace(/\s+/g, '')), (c) => c.charCodeAt(0)))
export const hex = (text: string) => [...utf8.encode(text)].map((b) => b.toString(16).padStart(2, '0')).join(' ')
export const hexDecode = (text: string) => {
  const clean = text.replace(/[^0-9a-f]/gi, '')
  if (clean.length % 2 || !clean) throw new Error('not hex')
  return utf8d.decode(Uint8Array.from(clean.match(/../g)!, (h) => parseInt(h, 16)))
}
export const binary = (text: string) => [...utf8.encode(text)].map((b) => b.toString(2).padStart(8, '0')).join(' ')
export const binaryDecode = (text: string) => {
  const clean = text.replace(/[^01]/g, '')
  if (clean.length % 8 || !clean) throw new Error('not binary')
  return utf8d.decode(Uint8Array.from(clean.match(/.{8}/g)!, (b) => parseInt(b, 2)))
}

const MORSE: Record<string, string> = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..', '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.', '.': '.-.-.-', ',': '--..--', '?': '..--..', '!': '-.-.--', '/': '-..-.', '@': '.--.-.', '-': '-....-', ':': '---...', "'": '.----.', '"': '.-..-.', '(': '-.--.', ')': '-.--.-', '=': '-...-', '+': '.-.-.' }
const MORSE_BACK = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]))
export const morse = (text: string) =>
  text
    .toUpperCase()
    .split(/\s+/)
    .map((w) => [...w].map((c) => MORSE[c] ?? '').filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' / ')
export const morseDecode = (text: string) =>
  text
    .trim()
    .split(/\s*\/\s*|\s{3,}/)
    .map((w) => w.trim().split(/\s+/).map((c) => MORSE_BACK[c] ?? '?').join(''))
    .join(' ')

export const reverse = (text: string) => [...text].reverse().join('')

// zero-width: 8 bits per byte, U+200B = 0, U+200C = 1, wrapped in U+200D markers, spread through the cover text
const ZW0 = '​'
const ZW1 = '‌'
const ZWM = '‍'
export function zeroWidthHide(secret: string, cover: string): string {
  const bits = [...utf8.encode(secret)].map((b) => b.toString(2).padStart(8, '0')).join('')
  const hidden = ZWM + [...bits].map((b) => (b === '1' ? ZW1 : ZW0)).join('') + ZWM
  const words = cover.split(' ')
  if (words.length < 2) return cover + hidden
  // tuck the whole payload after the first word so it survives copy-paste of the sentence
  words[0] += hidden
  return words.join(' ')
}
export function zeroWidthReveal(text: string): string | null {
  const m = new RegExp(`${ZWM}([${ZW0}${ZW1}]+)${ZWM}`).exec(text)
  if (!m) return null
  const bits = [...m[1]].map((c) => (c === ZW1 ? '1' : '0')).join('')
  return utf8d.decode(Uint8Array.from(bits.match(/.{8}/g) ?? [], (b) => parseInt(b, 2)))
}
export const stripZeroWidth = (text: string) => text.replace(/[​‌‍﻿]/g, '')

export function encode(text: string, layer: Layer): string {
  switch (layer.kind) {
    case 'caesar':
      return caesar(text, layer.shift)
    case 'rot13':
      return caesar(text, 13)
    case 'atbash':
      return atbash(text)
    case 'a1z26':
      return a1z26(text)
    case 'vigenere':
      return vigenere(text, layer.key)
    case 'base64':
      return base64(text)
    case 'hex':
      return hex(text)
    case 'binary':
      return binary(text)
    case 'morse':
      return morse(text)
    case 'reverse':
      return reverse(text)
    case 'zerowidth':
      return zeroWidthHide(text, layer.cover || 'Nothing to see here.')
  }
}

export function decode(text: string, layer: Layer): string {
  switch (layer.kind) {
    case 'caesar':
      return caesar(text, -layer.shift)
    case 'rot13':
      return caesar(text, 13)
    case 'atbash':
      return atbash(text)
    case 'a1z26':
      return a1z26Decode(text)
    case 'vigenere':
      return vigenere(text, layer.key, true)
    case 'base64':
      return base64Decode(text)
    case 'hex':
      return hexDecode(text)
    case 'binary':
      return binaryDecode(text)
    case 'morse':
      return morseDecode(text)
    case 'reverse':
      return reverse(text)
    case 'zerowidth':
      return zeroWidthReveal(text) ?? ''
  }
}

export const encodeAll = (text: string, layers: Layer[]) => layers.reduce((t, l) => encode(t, l), text)
export const decodeAll = (text: string, layers: Layer[]) => [...layers].reverse().reduce((t, l) => decode(t, l), text)

/** How a player would describe undoing the layers, last applied first. */
export function describeLayer(layer: Layer): string {
  switch (layer.kind) {
    case 'caesar':
      return `Caesar shift ${layer.shift} (shift back by ${layer.shift})`
    case 'rot13':
      return 'ROT13'
    case 'atbash':
      return 'Atbash'
    case 'a1z26':
      return 'A1Z26 (numbers → letters)'
    case 'vigenere':
      return `Vigenère with key "${layer.key}"`
    case 'base64':
      return 'Base64'
    case 'hex':
      return 'hex → text'
    case 'binary':
      return 'binary → text'
    case 'morse':
      return 'Morse code'
    case 'reverse':
      return 'reversed text'
    case 'zerowidth':
      return 'invisible zero-width characters hidden in the text (paste into a zero-width decoder)'
  }
}

// ---------------------------------------------------------------- guessing

const COMMON = ['the', 'and', 'you', 'that', 'for', 'this', 'with', 'are', 'have', 'not', 'find', 'look', 'next', 'clue', 'key', 'password', 'video', 'file', 'open', 'hidden', 'secret', 'code', 'is', 'in', 'to', 'of', 'a']
/** Roughly: does this read like English? Counts common words and the share of letters. */
export function englishScore(text: string): number {
  const lower = text.toLowerCase()
  const words = lower.split(/[^a-z']+/).filter(Boolean)
  if (!words.length) return 0
  const hits = words.filter((w) => COMMON.includes(w)).length
  const letters = (lower.match(/[a-z ]/g) || []).length / Math.max(1, lower.length)
  return hits * 3 + letters * 2 + (words.some((w) => w.length > 3) ? 1 : 0)
}

export interface Guess {
  method: string
  result: string
  score: number
}

/** Try everything that needs no key; best-looking first. */
export function autoDecode(input: string, vigenereKey = ''): Guess[] {
  const text = input.trim()
  const out: Guess[] = []
  const attempt = (method: string, fn: () => string) => {
    try {
      const r = fn()
      if (r && r !== text && !/[�]/.test(r) && /[\x20-\x7e\n]/.test(r)) out.push({ method, result: r, score: englishScore(r) })
    } catch {
      // not that encoding
    }
  }
  const zw = zeroWidthReveal(text)
  if (zw) out.push({ method: 'Invisible ink (zero-width characters)', result: zw, score: 100 })
  if (/^[A-Za-z0-9+/=\s]+$/.test(text) && text.replace(/\s/g, '').length % 4 === 0) attempt('Base64', () => base64Decode(text))
  if (/^[0-9a-fA-F\s]+$/.test(text) && text.replace(/\s/g, '').length % 2 === 0) attempt('Hex', () => hexDecode(text))
  if (/^[01\s]+$/.test(text)) attempt('Binary', () => binaryDecode(text))
  if (/^[.\-\s/]+$/.test(text)) attempt('Morse', () => morseDecode(text))
  if (/^[\d\s\-.,]+$/.test(text)) attempt('A1Z26', () => a1z26Decode(text))
  attempt('Atbash', () => atbash(text))
  attempt('Reversed', () => reverse(text))
  for (let s = 1; s < 26; s++) attempt(`Caesar shift ${s} back${s === 13 ? ' (ROT13)' : ''}`, () => caesar(text, -s))
  if (vigenereKey) attempt(`Vigenère with "${vigenereKey}"`, () => vigenere(text, vigenereKey, true))
  return out.sort((a, b) => b.score - a.score)
}
