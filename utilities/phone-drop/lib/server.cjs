// A small LAN web server: the phone opens one secret URL and can then send files/text to this PC
// and fetch what the PC shares. Plain Node (http, fs) so it can be tested without Electron.
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { pipeline } = require('node:stream/promises')
const { phonePage } = require('./phone-page.cjs')

const MAX_UPLOAD = 16 * 1024 ** 3 // 16 GB per file
const MAX_TEXT = 200_000
const PREFERRED_PORT = 8787

/** LAN IPv4 addresses, most likely "the Wi-Fi the phone is on" first. */
function lanAddresses() {
  const found = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal) continue
      let score = 0
      if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(info.address)) score += 3
      if (/wi-?fi|wlan|wireless|ethernet/i.test(name)) score += 2
      if (/vethernet|virtual|vmware|vbox|hyper-v|wsl|loopback|bluetooth|tailscale|zerotier|vpn|tap|tun/i.test(name)) score -= 5
      if (info.address.startsWith('169.254.')) score -= 5
      found.push({ name, address: info.address, score })
    }
  }
  return found.sort((a, b) => b.score - a.score)
}

/** Keep just a safe file name: no folders, no reserved Windows names, no trailing dots. */
function safeName(raw) {
  let name = String(raw || '').replace(/[\\/]/g, '_').replace(/[<>:"|?*\x00-\x1f]/g, '_').trim()
  name = name.replace(/[. ]+$/, '')
  if (!name || name === '.' || name === '..') name = 'file'
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = '_' + name
  if (name.length > 180) {
    const ext = path.extname(name).slice(0, 20)
    name = name.slice(0, 180 - ext.length) + ext
  }
  return name
}

function uniquePath(dir, name) {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = path.join(dir, name)
  for (let i = 2; fs.existsSync(candidate) || fs.existsSync(candidate + '.part'); i++) candidate = path.join(dir, `${stem} (${i})${ext}`)
  return candidate
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

class DropServer extends EventEmitter {
  /** @param {{ receiveDir: string, pcName?: string, port?: number, host?: string }} opts */
  constructor(opts) {
    super()
    this.receiveDir = opts.receiveDir
    // '0.0.0.0' = reachable from the Wi-Fi. Tests pass '127.0.0.1' so they never touch the firewall.
    this.host = opts.host || '0.0.0.0'
    this.pcName = opts.pcName || os.hostname()
    this.preferredPort = opts.port ?? PREFERRED_PORT
    this.token = crypto.randomBytes(5).toString('hex')
    this.server = null
    this.port = 0
    this.sockets = new Set()
    this.streams = new Set() // open SSE responses = phones currently on the page
    this.shared = new Map() // id -> { id, path, name, size }
    this.texts = [] // newest last: { id, text, from: 'pc' | 'phone', time }
    this.received = [] // { id, name, path, size, time }
    this.heartbeat = null
  }

  async start() {
    if (this.server) return this.info()
    const server = http.createServer((req, res) => {
      this.route(req, res).catch((err) => {
        if (!res.headersSent) this.send(res, 500, { error: 'Server error' })
        else res.destroy()
        this.emit('log', 'error', err.message)
      })
    })
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    server.requestTimeout = 0 // big uploads over slow Wi-Fi take as long as they take
    server.headersTimeout = 20_000
    const listen = (port) =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, this.host, () => {
          server.off('error', reject)
          resolve()
        })
      })
    try {
      await listen(this.preferredPort)
    } catch (err) {
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err
      await listen(0)
    }
    this.server = server
    this.port = server.address().port
    this.heartbeat = setInterval(() => this.broadcast(':keep-alive\n\n', true), 25_000)
    this.heartbeat.unref?.()
    return this.info()
  }

  async stop() {
    clearInterval(this.heartbeat)
    const server = this.server
    this.server = null
    if (!server) return
    for (const res of this.streams) res.end()
    this.streams.clear()
    for (const socket of this.sockets) socket.destroy()
    await new Promise((resolve) => server.close(() => resolve()))
    this.port = 0
  }

  info() {
    const addresses = this.host === '127.0.0.1' ? [{ name: 'This PC only', address: '127.0.0.1', score: 0 }] : lanAddresses()
    return {
      running: !!this.server,
      port: this.port,
      token: this.token,
      pcName: this.pcName,
      receiveDir: this.receiveDir,
      addresses,
      urls: addresses.map((a) => `http://${a.address}:${this.port}/${this.token}/`),
      phones: this.streams.size,
    }
  }

  state() {
    return {
      ...this.info(),
      shared: [...this.shared.values()].map(({ id, name, size, path: p }) => ({ id, name, size, path: p })),
      texts: this.texts,
      received: this.received,
    }
  }

  /** What the phone is allowed to see: no local paths. */
  publicState() {
    return {
      pcName: this.pcName,
      files: [...this.shared.values()].map(({ id, name, size }) => ({ id, name, size })),
      texts: this.texts,
    }
  }

  // ---- things the PC does

  shareFile(filePath) {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) throw new Error('Only files can be shared (zip a folder first)')
    for (const item of this.shared.values()) if (item.path === filePath) return item
    const item = { id: crypto.randomBytes(6).toString('hex'), path: filePath, name: path.basename(filePath), size: stat.size }
    this.shared.set(item.id, item)
    this.changed()
    return item
  }

  unshare(id) {
    if (this.shared.delete(id)) this.changed()
  }

  addText(text, from) {
    const clean = String(text || '').slice(0, MAX_TEXT)
    if (!clean.trim()) return null
    const entry = { id: crypto.randomBytes(6).toString('hex'), text: clean, from, time: Date.now() }
    this.texts.push(entry)
    if (this.texts.length > 50) this.texts.shift()
    this.changed()
    return entry
  }

  removeText(id) {
    const before = this.texts.length
    this.texts = this.texts.filter((t) => t.id !== id)
    if (this.texts.length !== before) this.changed()
  }

  changed() {
    this.emit('state', this.state())
    this.broadcast(`data: ${JSON.stringify(this.publicState())}\n\n`)
  }

  broadcast(chunk) {
    for (const res of this.streams) res.write(chunk)
  }

  // ---- http

  send(res, status, body, headers = {}) {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    })
    res.end(data)
  }

  async route(req, res) {
    const url = new URL(req.url, 'http://x')
    const parts = url.pathname.split('/').filter(Boolean)
    // Everything lives under /<token>/ — anything else looks like an empty server.
    if (parts.length === 0 || !sameToken(parts[0], this.token)) return this.send(res, 404, { error: 'Not found' })
    const rest = parts.slice(1).join('/')

    if (req.method === 'GET' && rest === '') {
      if (!url.pathname.endsWith('/')) return this.send(res, 302, '', { Location: `/${this.token}/` })
      return this.send(res, 200, phonePage({ pcName: this.pcName }), {
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'",
      })
    }
    if (req.method === 'GET' && rest === 'api/state') return this.send(res, 200, this.publicState())
    if (req.method === 'GET' && rest === 'api/events') return this.events(req, res)
    if (req.method === 'GET' && parts[1] === 'file' && parts[2]) return this.download(req, res, parts[2])
    if (req.method === 'POST' && rest === 'upload') return this.upload(req, res, url.searchParams.get('name'))
    if (req.method === 'POST' && rest === 'text') return this.text(req, res)
    return this.send(res, 404, { error: 'Not found' })
  }

  events(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    res.write(`data: ${JSON.stringify(this.publicState())}\n\n`)
    this.streams.add(res)
    this.emit('state', this.state())
    req.on('close', () => {
      this.streams.delete(res)
      this.emit('state', this.state())
    })
  }

  async download(req, res, id) {
    const item = this.shared.get(id)
    if (!item) return this.send(res, 404, { error: 'That file is no longer shared' })
    let stat
    try {
      stat = await fs.promises.stat(item.path)
    } catch {
      this.unshare(id)
      return this.send(res, 404, { error: 'That file was moved or deleted' })
    }
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }
    let start = 0
    let end = stat.size - 1
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
    if (range && stat.size > 0) {
      if (range[1] === '' && range[2] !== '') start = Math.max(0, stat.size - Number(range[2]))
      else {
        start = Number(range[1])
        if (range[2] !== '') end = Math.min(end, Number(range[2]))
      }
      if (start > end || start >= stat.size) return this.send(res, 416, { error: 'Bad range' }, { 'Content-Range': `bytes */${stat.size}` })
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 })
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': stat.size })
    }
    if (stat.size === 0) return res.end()
    await pipeline(fs.createReadStream(item.path, { start, end }), res).catch(() => {}) // phone cancelled: fine
    if (end === stat.size - 1) this.emit('sent', { name: item.name, size: stat.size })
  }

  async upload(req, res, rawName) {
    const total = Number(req.headers['content-length'] || 0)
    if (total > MAX_UPLOAD) return this.send(res, 413, { error: 'File is too large' })
    await fs.promises.mkdir(this.receiveDir, { recursive: true })
    const name = safeName(rawName)
    const target = uniquePath(this.receiveDir, name)
    const part = target + '.part'
    const id = crypto.randomBytes(6).toString('hex')
    let received = 0
    let lastEmit = 0
    req.on('data', (chunk) => {
      received += chunk.length
      if (received > MAX_UPLOAD) req.destroy(new Error('too large'))
      const now = Date.now()
      if (now - lastEmit > 120) {
        lastEmit = now
        this.emit('upload-progress', { id, name: path.basename(target), received, total })
      }
    })
    try {
      await pipeline(req, fs.createWriteStream(part, { flags: 'wx' }))
      if (total && received !== total) throw new Error('incomplete upload')
      await fs.promises.rename(part, target)
    } catch (err) {
      await fs.promises.rm(part, { force: true })
      this.emit('upload-progress', { id, name: path.basename(target), received, total, failed: true })
      if (!res.headersSent && !res.destroyed) this.send(res, 400, { error: 'Upload did not finish' })
      return
    }
    const entry = { id, name: path.basename(target), path: target, size: received, time: Date.now() }
    this.received.push(entry)
    if (this.received.length > 200) this.received.shift()
    this.emit('upload-progress', { id, name: entry.name, received, total: received, done: true })
    this.emit('received', entry)
    this.emit('state', this.state())
    this.send(res, 200, { ok: true, name: entry.name })
  }

  async text(req, res) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_TEXT * 4) return this.send(res, 413, { error: 'Too much text' })
      chunks.push(chunk)
    }
    let text = ''
    try {
      text = JSON.parse(Buffer.concat(chunks).toString('utf8')).text
    } catch {
      return this.send(res, 400, { error: 'Bad request' })
    }
    const entry = this.addText(text, 'phone')
    if (!entry) return this.send(res, 400, { error: 'Nothing to send' })
    this.emit('text', entry)
    this.send(res, 200, { ok: true })
  }
}

module.exports = { DropServer, lanAddresses, safeName, uniquePath }
