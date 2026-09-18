// Mystery Maker backend: the one thing the page cannot do itself — mark folders hidden on Windows.
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

module.exports = {
  handlers: {
    /** attrib +h on each folder (must be inside a folder the user picked). */
    async hide({ paths }, ctx) {
      const done = []
      for (const p of paths || []) {
        if (typeof p !== 'string' || !ctx.isAllowed(p) || !fs.existsSync(p)) continue
        if (process.platform === 'win32') {
          await new Promise((resolve) => execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'attrib.exe'), ['+h', p], { windowsHide: true, timeout: 5000 }, () => resolve()))
        } else {
          const dir = path.dirname(p)
          const base = path.basename(p)
          if (!base.startsWith('.')) fs.renameSync(p, path.join(dir, '.' + base))
        }
        done.push(p)
      }
      return { hidden: done }
    },
  },
}
