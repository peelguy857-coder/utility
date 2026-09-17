// Phone Drop backend: owns the LAN server (lib/server.cjs) and relays its events to the UI.
const path = require('node:path')
const fs = require('node:fs')
const { app, shell, clipboard } = require('electron')
const { DropServer } = require('./lib/server.cjs')

/** @type {DropServer | null} */
let server = null

const SAFE_TO_OPEN = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp', '.mp4', '.mov', '.m4v', '.webm', '.mp3', '.m4a', '.wav', '.aac', '.pdf', '.txt'])

function receiveDir(ctx) {
  if (process.env.UTILITY_SHOTS_DIR) return path.join(ctx.tempDir(), 'received') // test runs never touch Downloads
  return ctx.settings.get().receiveDir || path.join(app.getPath('downloads'), 'Phone Drop')
}

function stoppedState(ctx) {
  return { running: false, port: 0, token: '', urls: [], addresses: [], phones: 0, shared: [], texts: [], received: [], pcName: '', receiveDir: receiveDir(ctx) }
}

module.exports = {
  async dispose() {
    if (server) await server.stop()
    server = null
  },

  handlers: {
    async state(_args, ctx) {
      return server ? server.state() : stoppedState(ctx)
    },

    async start(_args, ctx) {
      if (!server) {
        // screenshot runs stay on loopback so they never trigger a firewall prompt
        server = new DropServer({ receiveDir: receiveDir(ctx), host: process.env.UTILITY_SHOTS_DIR ? '127.0.0.1' : '0.0.0.0' })
        server.on('state', (state) => ctx.emit('state', state))
        server.on('upload-progress', (p) => ctx.emit('upload-progress', p))
        server.on('received', (entry) => ctx.emit('received', entry))
        server.on('text', (entry) => ctx.emit('text', entry))
        server.on('sent', (info) => ctx.emit('sent', info))
      }
      await server.start()
      return server.state()
    },

    async stop(_args, ctx) {
      if (server) await server.stop()
      server = null
      return stoppedState(ctx)
    },

    async share({ paths }, ctx) {
      if (!server) throw new Error('Start sharing first')
      const problems = []
      for (const p of paths || []) {
        if (!ctx.isAllowed(p)) continue
        try {
          server.shareFile(p)
        } catch (err) {
          problems.push(`${path.basename(p)}: ${err.message}`)
        }
      }
      return { state: server.state(), problems }
    },

    async unshare({ id }) {
      server?.unshare(String(id))
      return server?.state()
    },

    async sendText({ text }) {
      if (!server) throw new Error('Start sharing first')
      if (!server.addText(text, 'pc')) throw new Error('Nothing to send')
      return server.state()
    },

    async removeText({ id }) {
      server?.removeText(String(id))
      return server?.state()
    },

    async copyText({ text }) {
      clipboard.writeText(String(text ?? ''))
    },

    async chooseFolder({ folder }, ctx) {
      if (!folder || !ctx.isAllowed(folder)) throw new Error('Pick a folder first')
      ctx.settings.set({ receiveDir: folder })
      if (server) server.receiveDir = folder
      return server ? server.state() : stoppedState(ctx)
    },

    async openFolder(_args, ctx) {
      const dir = receiveDir(ctx)
      await fs.promises.mkdir(dir, { recursive: true })
      await shell.openPath(dir)
    },

    async reveal({ id }) {
      const entry = server?.received.find((r) => r.id === id)
      if (entry && fs.existsSync(entry.path)) shell.showItemInFolder(entry.path)
      else throw new Error('That file was moved or deleted')
    },

    async open({ id }) {
      const entry = server?.received.find((r) => r.id === id)
      if (!entry || !fs.existsSync(entry.path)) throw new Error('That file was moved or deleted')
      // Anything on the Wi-Fi that knows the link can upload, so only plain media/documents are
      // opened straight from the app. Everything else is shown in Explorer instead.
      if (!SAFE_TO_OPEN.has(path.extname(entry.path).toLowerCase())) {
        shell.showItemInFolder(entry.path)
        return
      }
      const problem = await shell.openPath(entry.path)
      if (problem) throw new Error(problem)
    },
  },
}
