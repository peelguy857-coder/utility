// What the user can choose, the presets that fill those choices, and small helpers around them.

export type ResizeMode = 'keep' | 'fit' | 'cover' | 'stretch' | 'scale'
export type OutFormat = 'png' | 'jpeg' | 'webp'
export type SizeUnit = 'KB' | 'MB'

export interface Options {
  preset: string
  mode: ResizeMode
  width: number
  height: number
  lockAspect: boolean
  /** Percent, for mode 'scale'. */
  scale: number
  noUpscale: boolean
  /** mode 'fit' only: pad the result to exactly width x height. */
  pad: boolean
  format: OutFormat
  /** 1-100, JPEG and WebP only. */
  quality: number
  /** Fills transparency (and padding) when the format is JPEG. */
  background: string
  limitOn: boolean
  limitValue: number
  limitUnit: SizeUnit
  pattern: string
}

export const DEFAULT_PATTERN = '{name}-{width}x{height}'

export const DEFAULT_OPTIONS: Options = {
  preset: 'custom',
  mode: 'keep',
  width: 1920,
  height: 1080,
  lockAspect: true,
  scale: 50,
  noUpscale: true,
  pad: false,
  format: 'png',
  quality: 85,
  background: '#ffffff',
  limitOn: false,
  limitValue: 2,
  limitUnit: 'MB',
  pattern: DEFAULT_PATTERN,
}

export interface Preset {
  id: string
  label: string
  /** One line under the select: what this preset does. */
  summary: string
  apply: Partial<Options>
}

function fixed(id: string, label: string, width: number, height: number, how: 'cover' | 'contain', format: OutFormat, limit?: [number, SizeUnit]): Preset {
  const parts = [`${width} × ${height}`, how === 'cover' ? 'cover & crop' : 'fit inside, padded', format === 'jpeg' ? 'JPEG' : format.toUpperCase()]
  if (limit) parts.push(`max ${limit[0]} ${limit[1]}`)
  return {
    id,
    label,
    summary: parts.join(' · '),
    apply: {
      mode: how === 'cover' ? 'cover' : 'fit',
      pad: how === 'contain',
      width,
      height,
      lockAspect: false,
      noUpscale: false, // stores and platforms want these exact pixel sizes
      format,
      ...(format === 'jpeg' ? { quality: 90 } : {}),
      limitOn: !!limit,
      ...(limit ? { limitValue: limit[0], limitUnit: limit[1] } : {}),
    },
  }
}

export const PRESETS: Preset[] = [
  { id: 'custom', label: 'Custom', summary: 'Your own size, format and limit.', apply: {} },
  fixed('yt-thumbnail', 'YouTube thumbnail', 1280, 720, 'cover', 'jpeg', [2, 'MB']),
  fixed('yt-banner', 'YouTube channel banner', 2560, 1440, 'cover', 'jpeg', [6, 'MB']),
  fixed('steam-header', 'Steam header capsule', 920, 430, 'cover', 'png'),
  fixed('steam-main', 'Steam main capsule', 1232, 706, 'cover', 'png'),
  fixed('steam-small', 'Steam small capsule', 462, 174, 'cover', 'png'),
  fixed('steam-vertical', 'Steam vertical capsule', 748, 896, 'cover', 'png'),
  fixed('steam-library', 'Steam library capsule', 600, 900, 'cover', 'png'),
  fixed('steam-hero', 'Steam library hero', 3840, 1240, 'cover', 'png'),
  fixed('discord-emoji', 'Discord emoji', 128, 128, 'contain', 'png', [256, 'KB']),
  fixed('discord-icon', 'Discord server icon', 512, 512, 'cover', 'png'),
  fixed('app-icon', 'App icon source', 1024, 1024, 'contain', 'png'),
  { id: 'half', label: 'Half size', summary: '50 % of the original, format unchanged.', apply: { mode: 'scale', scale: 50 } },
  {
    id: 'web',
    label: 'Web-friendly',
    summary: 'Long edge max 1920 px · WebP · quality 82',
    apply: { mode: 'fit', pad: false, width: 1920, height: 1920, lockAspect: false, noUpscale: true, format: 'webp', quality: 82, limitOn: false },
  },
]

export const getPreset = (id: string) => PRESETS.find((p) => p.id === id) ?? PRESETS[0]

export function applyPreset(current: Options, id: string): Options {
  const preset = getPreset(id)
  return { ...current, ...preset.apply, preset: preset.id }
}

/** Fields that define a preset: editing one of them by hand turns the preset into "Custom". */
export const PRESET_FIELDS: Array<keyof Options> = ['mode', 'width', 'height', 'scale', 'pad', 'format', 'limitOn', 'limitValue', 'limitUnit']

export function limitBytes(o: Pick<Options, 'limitOn' | 'limitValue' | 'limitUnit'>): number | null {
  if (!o.limitOn || !(o.limitValue > 0)) return null
  return Math.floor(o.limitValue * (o.limitUnit === 'MB' ? 1024 * 1024 : 1024))
}

export const FORMAT_LABEL: Record<OutFormat, string> = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP' }
export const FORMAT_EXT: Record<OutFormat, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' }
export const FORMAT_MIME: Record<OutFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }

export function formatFromExt(ext: string): OutFormat | null {
  const e = ext.toLowerCase()
  if (e === 'png') return 'png'
  if (e === 'jpg' || e === 'jpeg') return 'jpeg'
  if (e === 'webp') return 'webp'
  return null
}

/** Everything that changes the produced bytes. Used to know when a cached result is still valid. */
export function outputKey(o: Options): string {
  const geometry = o.mode === 'keep' ? 'keep' : o.mode === 'scale' ? `scale:${o.scale}:${o.noUpscale}` : `${o.mode}:${o.width}x${o.height}:${o.noUpscale}:${o.mode === 'fit' && o.pad}`
  const encode = o.format === 'png' ? 'png' : `${o.format}:${o.quality}${o.format === 'jpeg' ? ':' + o.background : ''}`
  return `${geometry}|${encode}|${limitBytes(o) ?? 'nolimit'}`
}

/** Keep stored settings sane: unknown keys dropped, wrong types replaced by the default. */
export function sanitizeOptions(raw: unknown): Options {
  const out: Options = { ...DEFAULT_OPTIONS }
  if (!raw || typeof raw !== 'object') return out
  const src = raw as Record<string, unknown>
  const num = (key: 'width' | 'height' | 'scale' | 'quality' | 'limitValue', min: number, max: number) => {
    const v = src[key]
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.min(max, Math.max(min, v))
  }
  const bool = (key: 'lockAspect' | 'noUpscale' | 'pad' | 'limitOn') => {
    if (typeof src[key] === 'boolean') out[key] = src[key] as boolean
  }
  num('width', 1, 16384)
  num('height', 1, 16384)
  num('scale', 1, 400)
  num('quality', 1, 100)
  num('limitValue', 0.01, 100000)
  bool('lockAspect')
  bool('noUpscale')
  bool('pad')
  bool('limitOn')
  if (typeof src.mode === 'string' && ['keep', 'fit', 'cover', 'stretch', 'scale'].includes(src.mode)) out.mode = src.mode as ResizeMode
  if (typeof src.format === 'string' && ['png', 'jpeg', 'webp'].includes(src.format)) out.format = src.format as OutFormat
  if (src.limitUnit === 'KB' || src.limitUnit === 'MB') out.limitUnit = src.limitUnit
  if (typeof src.background === 'string' && /^#[0-9a-f]{6}$/i.test(src.background)) out.background = src.background
  if (typeof src.pattern === 'string' && src.pattern.trim()) out.pattern = src.pattern.slice(0, 120)
  if (typeof src.preset === 'string' && PRESETS.some((p) => p.id === src.preset)) out.preset = src.preset
  return out
}
