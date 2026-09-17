// Tiny JSON settings store. One file in userData, written atomically and debounced.
const fs = require('node:fs')
const path = require('node:path')

const DEFAULTS = {
  theme: 'system', // 'system' | 'dark' | 'light'
  pinned: ['dmg-maker', 'phone-mirror'],
  recent: [],
  sidebarCollapsed: false,
  util: {}, // per-utility settings, keyed by utility id
}

class Settings {
  constructor(file) {
    this.file = file
    this.data = structuredClone(DEFAULTS)
    this.timer = null
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (raw && typeof raw === 'object') this.data = { ...this.data, ...raw, util: { ...(raw.util || {}) } }
    } catch {
      // first run or unreadable file: keep defaults
    }
  }

  all() {
    return this.data
  }

  set(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'util') continue // per-utility settings go through setUtil
      if (k in DEFAULTS) this.data[k] = v
    }
    this.save()
    return this.data
  }

  getUtil(id) {
    return this.data.util[id] || {}
  }

  setUtil(id, patch) {
    this.data.util[id] = { ...(this.data.util[id] || {}), ...patch }
    this.save()
    return this.data.util[id]
  }

  save() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 250)
  }

  flush() {
    clearTimeout(this.timer)
    this.timer = null
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
      fs.renameSync(tmp, this.file)
    } catch (err) {
      console.error('[settings] could not save:', err.message)
    }
  }
}

module.exports = { Settings }
