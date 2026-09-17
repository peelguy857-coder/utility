// QR helpers shared by QR Maker and Phone Drop. Encoding is done by qrcode-generator.
import qrcode from 'qrcode-generator'

export type QrLevel = 'L' | 'M' | 'Q' | 'H'

export interface QrStyle {
  /** Quiet zone in modules. The spec says 4; 2 still scans well on screens. */
  margin: number
  fg: string
  bg: string
  /** Draw modules as dots / rounded squares instead of plain squares. */
  rounded: boolean
}

// The library defaults to a Latin-1-ish encoding; phones expect UTF-8.
qrcode.stringToBytes = (s: string) => Array.from(new TextEncoder().encode(s))

/** Returns the module grid (true = dark). Throws if the text is too long for a QR code. */
export function qrMatrix(text: string, level: QrLevel = 'M'): boolean[][] {
  const qr = qrcode(0, level)
  qr.addData(text, 'Byte')
  qr.make()
  const n = qr.getModuleCount()
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)))
}

const isFinder = (n: number, r: number, c: number) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7)

export function drawQr(canvas: HTMLCanvasElement, matrix: boolean[][], size: number, style: QrStyle) {
  const n = matrix.length
  const total = n + style.margin * 2
  const cell = Math.max(1, Math.floor(size / total))
  const px = cell * total
  canvas.width = px
  canvas.height = px
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = style.bg
  ctx.fillRect(0, 0, px, px)
  ctx.fillStyle = style.fg
  const off = style.margin * cell
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!matrix[r][c]) continue
      const x = off + c * cell
      const y = off + r * cell
      // keep the three finder patterns square so every scanner locks on
      if (style.rounded && !isFinder(n, r, c)) {
        ctx.beginPath()
        ctx.roundRect(x + cell * 0.06, y + cell * 0.06, cell * 0.88, cell * 0.88, cell * 0.38)
        ctx.fill()
      } else {
        ctx.fillRect(x, y, cell, cell)
      }
    }
  }
}

export function qrSvg(matrix: boolean[][], style: QrStyle): string {
  const n = matrix.length
  const total = n + style.margin * 2
  let path = ''
  let dots = ''
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!matrix[r][c]) continue
      const x = c + style.margin
      const y = r + style.margin
      if (style.rounded && !isFinder(n, r, c)) dots += `<rect x="${x + 0.06}" y="${y + 0.06}" width="0.88" height="0.88" rx="0.38"/>`
      else path += `M${x} ${y}h1v1h-1z`
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="${style.rounded ? 'geometricPrecision' : 'crispEdges'}">` +
    `<rect width="${total}" height="${total}" fill="${style.bg}"/>` +
    `<g fill="${style.fg}"><path d="${path}"/>${dots}</g></svg>`
  )
}

export function wifiPayload(ssid: string, password: string, security: 'WPA' | 'WEP' | 'nopass', hidden: boolean): string {
  const esc = (s: string) => s.replace(/([\\;,:"])/g, '\\$1')
  return `WIFI:T:${security};S:${esc(ssid)};${security === 'nopass' ? '' : `P:${esc(password)};`}${hidden ? 'H:true;' : ''};`
}
