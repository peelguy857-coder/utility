// Finds the backend half of every utility (utilities/<id>/main.cjs) and routes calls to it.
//
// A backend module looks like:
//   module.exports = {
//     async init(ctx) {},            // optional, runs once before the first call
//     async dispose() {},            // optional, runs on quit (stop servers, kill children)
//     handlers: { async name(args, ctx) { return result } },
//   }
// Backends are loaded lazily, on first use, so a broken or slow utility never delays startup.
const fs = require('node:fs')
const path = require('node:path')

const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/

class Registry {
  /**
   * @param {{ root: string, makeContext: (id: string) => object }} opts
   */
  constructor({ root, makeContext }) {
    this.root = root
    this.makeContext = makeContext
    this.loaded = new Map() // id -> { mod, ctx, ready: Promise }
  }

  /** Utility ids that have a backend. UI-only utilities simply have no main.cjs. */
  list() {
    let names = []
    try {
      names = fs.readdirSync(this.root, { withFileTypes: true })
    } catch {
      return []
    }
    return names
      .filter((d) => d.isDirectory() && ID_RE.test(d.name) && fs.existsSync(path.join(this.root, d.name, 'main.cjs')))
      .map((d) => d.name)
  }

  load(id) {
    if (!ID_RE.test(id)) throw new Error(`Bad utility id: ${id}`)
    let entry = this.loaded.get(id)
    if (entry) return entry
    const file = path.join(this.root, id, 'main.cjs')
    if (!fs.existsSync(file)) throw new Error(`Utility "${id}" has no backend`)
    const mod = require(file)
    const ctx = this.makeContext(id)
    const ready = Promise.resolve(mod.init ? mod.init(ctx) : undefined)
    entry = { mod, ctx, ready }
    this.loaded.set(id, entry)
    return entry
  }

  async invoke(id, method, args) {
    const entry = this.load(id)
    await entry.ready
    const fn = entry.mod.handlers && Object.hasOwn(entry.mod.handlers, method) ? entry.mod.handlers[method] : null
    if (typeof fn !== 'function') throw new Error(`Utility "${id}" has no method "${method}"`)
    return fn(args ?? {}, entry.ctx)
  }

  async disposeAll() {
    const jobs = []
    for (const [id, entry] of this.loaded) {
      if (typeof entry.mod.dispose !== 'function') continue
      jobs.push(
        Promise.resolve()
          .then(() => entry.mod.dispose())
          .catch((err) => console.error(`[${id}] dispose failed:`, err.message)),
      )
    }
    await Promise.all(jobs)
  }
}

module.exports = { Registry }
