// What "Export" writes for each ticked output.
import { buildIcns, buildIco, ICNS_SIZES, type IconImage } from './containers'
import { renderSize } from './render'

export type PackId = 'ico' | 'icns' | 'png' | 'web' | 'electron' | 'tauri' | 'appstore'

export interface Pack {
  id: PackId
  name: string
  detail: string
}

export const PACKS: Pack[] = [
  { id: 'ico', name: 'Windows .ico', detail: '16 to 256 px in one file' },
  { id: 'icns', name: 'macOS .icns', detail: 'All sizes incl. Retina — also works as a DMG volume icon' },
  { id: 'png', name: 'PNG set', detail: '16, 32, 48, 64, 128, 256, 512, 1024' },
  { id: 'web', name: 'Website favicons', detail: 'favicon.ico, apple-touch-icon, 192/512 + manifest' },
  { id: 'electron', name: 'Electron build folder', detail: 'icon.ico, icon.icns, icon.png' },
  { id: 'tauri', name: 'Tauri icons folder', detail: 'Everything src-tauri/icons expects' },
  { id: 'appstore', name: 'App Store 1024', detail: 'Opaque PNG, no transparency (Apple rejects alpha)' },
]

export interface OutputFile {
  path: string
  bytes: Uint8Array
}

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const PNG_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024]
const TAURI_SQUARES = [30, 44, 71, 89, 107, 142, 150, 284, 310]

const text = (s: string) => new TextEncoder().encode(s)

export async function buildOutputs(master: OffscreenCanvas, packs: PackId[], name: string, flatColor: string, onStep?: (done: number, total: number) => void): Promise<OutputFile[]> {
  const cache = new Map<string, Promise<IconImage>>()
  const get = (size: number, opaque?: string) => {
    const key = `${size}|${opaque ?? ''}`
    let hit = cache.get(key)
    if (!hit) {
      hit = renderSize(master, size, opaque)
      cache.set(key, hit)
    }
    return hit
  }
  const many = (sizes: number[]) => Promise.all(sizes.map((s) => get(s)))

  const files: OutputFile[] = []
  let done = 0
  for (const pack of packs) {
    if (pack === 'ico') files.push({ path: `${name}.ico`, bytes: buildIco(await many(ICO_SIZES)) })
    if (pack === 'icns') files.push({ path: `${name}.icns`, bytes: buildIcns(await many(ICNS_SIZES)) })
    if (pack === 'png') for (const s of PNG_SIZES) files.push({ path: `png/${name}-${s}.png`, bytes: (await get(s)).png })
    if (pack === 'appstore') files.push({ path: `appstore/AppIcon-1024.png`, bytes: (await get(1024, flatColor)).png })
    if (pack === 'electron') {
      files.push({ path: 'electron/icon.ico', bytes: buildIco(await many(ICO_SIZES)) })
      files.push({ path: 'electron/icon.icns', bytes: buildIcns(await many(ICNS_SIZES)) })
      files.push({ path: 'electron/icon.png', bytes: (await get(1024)).png })
    }
    if (pack === 'tauri') {
      files.push({ path: 'tauri/32x32.png', bytes: (await get(32)).png })
      files.push({ path: 'tauri/128x128.png', bytes: (await get(128)).png })
      files.push({ path: 'tauri/128x128@2x.png', bytes: (await get(256)).png })
      files.push({ path: 'tauri/icon.png', bytes: (await get(512)).png })
      files.push({ path: 'tauri/icon.ico', bytes: buildIco(await many(ICO_SIZES)) })
      files.push({ path: 'tauri/icon.icns', bytes: buildIcns(await many(ICNS_SIZES)) })
      for (const s of TAURI_SQUARES) files.push({ path: `tauri/Square${s}x${s}Logo.png`, bytes: (await get(s)).png })
      files.push({ path: 'tauri/StoreLogo.png', bytes: (await get(50)).png })
    }
    if (pack === 'web') {
      files.push({ path: 'web/favicon.ico', bytes: buildIco(await many([16, 32, 48])) })
      files.push({ path: 'web/apple-touch-icon.png', bytes: (await get(180, flatColor)).png })
      files.push({ path: 'web/icon-192.png', bytes: (await get(192)).png })
      files.push({ path: 'web/icon-512.png', bytes: (await get(512)).png })
      files.push({
        path: 'web/site.webmanifest',
        bytes: text(
          JSON.stringify(
            {
              name,
              icons: [
                { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
                { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
              ],
              display: 'standalone',
            },
            null,
            2,
          ) + '\n',
        ),
      })
      files.push({
        path: 'web/head.html',
        bytes: text(
          [
            '<link rel="icon" href="/favicon.ico" sizes="48x48">',
            '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
            '<link rel="manifest" href="/site.webmanifest">',
            '',
          ].join('\n'),
        ),
      })
    }
    onStep?.(++done, packs.length)
  }
  return files
}
