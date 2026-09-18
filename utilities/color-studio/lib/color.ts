// Colour maths: sRGB ↔ HSL / HSV / OKLCH, WCAG contrast, and perceptually even scales.

export interface Rgb {
  r: number
  g: number
  b: number
  a: number
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Any CSS colour string → rgba, using the browser's own parser (names, hsl(), oklch(), … all work). */
export function parse(input: string): Rgb | null {
  const text = input.trim()
  if (!text) return null
  const candidate = /^[0-9a-f]{3,8}$/i.test(text) ? '#' + text : text
  if (typeof CSS !== 'undefined' && !CSS.supports('color', candidate)) return null
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = candidate
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  // un-premultiply for translucent colours
  const alpha = a / 255
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 }
  return { r: Math.round(r / alpha), g: Math.round(g / alpha), b: Math.round(b / alpha), a: Math.round(alpha * 100) / 100 }
}

export const toHex = (c: Rgb, withAlpha = false) => '#' + [c.r, c.g, c.b, ...(withAlpha && c.a < 1 ? [Math.round(c.a * 255)] : [])].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')

export function toHsl(c: Rgb): { h: number; s: number; l: number } {
  const r = c.r / 255
  const g = c.g / 255
  const b = c.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  let s = 0
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
    else if (max === g) h = ((b - r) / d + 2) * 60
    else h = ((r - g) / d + 4) * 60
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) }
}

export function toHsv(c: Rgb): { h: number; s: number; v: number } {
  const r = c.r / 255
  const g = c.g / 255
  const b = c.b / 255
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  const { h } = toHsl(c)
  return { h, s: Math.round((max ? d / max : 0) * 100), v: Math.round(max * 100) }
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const fromLinear = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)

/** OKLab (Björn Ottosson) from sRGB. */
export function toOklab(c: Rgb): { L: number; a: number; b: number } {
  const r = toLinear(c.r / 255)
  const g = toLinear(c.g / 255)
  const b = toLinear(c.b / 255)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

export function fromOklab(L: number, a: number, b: number): { r: number; g: number; b: number; inGamut: boolean } {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  const inGamut = [lr, lg, lb].every((v) => v >= -0.0005 && v <= 1.0005)
  return { r: Math.round(clamp01(fromLinear(clamp01(lr))) * 255), g: Math.round(clamp01(fromLinear(clamp01(lg))) * 255), b: Math.round(clamp01(fromLinear(clamp01(lb))) * 255), inGamut }
}

export function toOklch(c: Rgb): { l: number; c: number; h: number } {
  const { L, a, b } = toOklab(c)
  const chroma = Math.hypot(a, b)
  let h = (Math.atan2(b, a) * 180) / Math.PI
  if (h < 0) h += 360
  return { l: Math.round(L * 1000) / 1000, c: Math.round(chroma * 1000) / 1000, h: chroma < 0.002 ? 0 : Math.round(h * 10) / 10 }
}

/** OKLCH → sRGB, pulling chroma in until the colour is displayable. */
export function fromOklch(l: number, c: number, h: number): Rgb {
  const rad = (h * Math.PI) / 180
  let chroma = c
  for (let i = 0; i < 24; i++) {
    const res = fromOklab(l, chroma * Math.cos(rad), chroma * Math.sin(rad))
    if (res.inGamut || chroma < 0.001) return { r: res.r, g: res.g, b: res.b, a: 1 }
    chroma *= 0.85
  }
  const res = fromOklab(l, 0, 0)
  return { r: res.r, g: res.g, b: res.b, a: 1 }
}

export function luminance(c: Rgb): number {
  return 0.2126 * toLinear(c.r / 255) + 0.7152 * toLinear(c.g / 255) + 0.0722 * toLinear(c.b / 255)
}

export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a)
  const lb = luminance(b)
  return Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100
}

/** Tailwind-style 50…950 scale around the colour's hue, evenly spaced in OKLCH lightness. */
export function scale(c: Rgb): Array<{ step: number; rgb: Rgb }> {
  const { c: chroma, h } = toOklch(c)
  const steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
  const light = [0.975, 0.945, 0.885, 0.81, 0.72, 0.62, 0.53, 0.45, 0.37, 0.29, 0.22]
  return steps.map((step, i) => ({ step, rgb: fromOklch(light[i], Math.min(chroma, 0.3) * (i === 0 || i === 10 ? 0.5 : i === 1 || i === 9 ? 0.75 : 1), h) }))
}

export function harmonies(c: Rgb): Array<{ name: string; colors: Rgb[] }> {
  const { l, c: chroma, h } = toOklch(c)
  const at = (deg: number) => fromOklch(l, chroma, (h + deg + 360) % 360)
  return [
    { name: 'Complementary', colors: [c, at(180)] },
    { name: 'Analogous', colors: [at(-30), c, at(30)] },
    { name: 'Triadic', colors: [c, at(120), at(240)] },
    { name: 'Split complementary', colors: [c, at(150), at(210)] },
    { name: 'Tetradic', colors: [c, at(90), at(180), at(270)] },
  ]
}

export const readable = (c: Rgb) => (luminance(c) > 0.35 ? '#111318' : '#ffffff')
