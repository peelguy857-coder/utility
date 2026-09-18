// Screen Recorder backend: lists what can be captured (screens and windows, with thumbnails) and
// writes the recording the UI produces to Videos\Utility, chunk by chunk.
const fs = require('node:fs')
const path = require('node:path')
const { app, desktopCapturer, shell } = require('electron')

let recording = null // { path, stream, bytes }

function recordingsDir() {
  const dir = path.join(app.getPath('videos'), 'Utility')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60)

module.exports = {
  async dispose() {
    if (recording) {
      const rec = recording
      recording = null
      await new Promise((r) => rec.stream.end(r))
    }
  },

  handlers: {
    /** Screens and windows the user can pick from. Thumbnails are data URLs. */
    async sources() {
      const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true })
      const own = app.getName()
      return list
        .filter((s) => !(s.name === own || s.name === 'Utility'))
        .map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.id.startsWith('screen') ? 'screen' : 'window',
          thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
          icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
        }))
    },

    async start({ ext, label }) {
      if (recording) throw new Error('A recording is already running')
      const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.')
      const file = path.join(recordingsDir(), `${safe(label) || 'Screen'} ${stamp}.${ext === 'webm' ? 'webm' : 'mp4'}`)
      recording = { path: file, stream: fs.createWriteStream(file), bytes: 0 }
      return { path: file }
    },

    async chunk({ data }) {
      if (!recording) throw new Error('No recording is running')
      const buf = Buffer.from(data)
      recording.bytes += buf.length
      if (!recording.stream.write(buf)) await new Promise((r) => recording.stream.once('drain', r))
      return { bytes: recording.bytes }
    },

    async stop({ discard } = {}) {
      const rec = recording
      recording = null
      if (!rec) return null
      await new Promise((r) => rec.stream.end(r))
      if (discard || rec.bytes === 0) {
        await fs.promises.rm(rec.path, { force: true })
        return null
      }
      return { path: rec.path, bytes: rec.bytes }
    },

    async openFolder() {
      await shell.openPath(recordingsDir())
    },

    async reveal({ path: p }) {
      if (typeof p === 'string' && p.startsWith(recordingsDir()) && fs.existsSync(p)) shell.showItemInFolder(p)
    },

    async recent() {
      const dir = recordingsDir()
      const files = (await fs.promises.readdir(dir))
        .filter((f) => /\.(mp4|webm)$/i.test(f))
        .map((f) => {
          const st = fs.statSync(path.join(dir, f))
          return { name: f, path: path.join(dir, f), bytes: st.size, mtime: st.mtimeMs }
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 12)
      return { dir, files }
    },
  },
}
