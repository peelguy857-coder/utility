// Project Launcher backend: keeps the list of project folders, runs their npm scripts as child
// processes (node.exe running npm-cli.js directly — no cmd.exe, no shell string), streams the output
// to the UI, and stops them again.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFile } = require('node:child_process')
const { shell } = require('electron')

const LOG_LINES = 400
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?[^\s"'<>)]*/g
const ID_RE = /^[\w-]{1,64}$/

/** id -> { child, since, lines: string[], urls: Set<string>, script } */
const running = new Map()
const logs = new Map() // id -> lines (kept after exit)

function findNode() {
  const candidates = [
    process.env.UTILITY_NODE,
    ...(process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, 'node.exe')),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
  ].filter(Boolean)
  for (const c of candidates) if (fs.existsSync(c)) return c
  return null
}

function findNpmCli(nodeExe) {
  const dir = path.dirname(nodeExe)
  const candidates = [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return null
}

function readPackage(folder) {
  const file = path.join(folder, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts) : []
  return { name: pkg.productName || pkg.name || path.basename(folder), scripts, description: typeof pkg.description === 'string' ? pkg.description.slice(0, 120) : '' }
}

/** Reasonable default script: dev, then start, then the first one. */
function defaultScript(scripts) {
  for (const s of ['dev', 'start', 'serve', 'app']) if (scripts.includes(s)) return s
  return scripts[0] || ''
}

function projects(ctx) {
  return Array.isArray(ctx.settings.get().projects) ? ctx.settings.get().projects : []
}

function status(id) {
  const r = running.get(id)
  return { running: !!r, pid: r ? r.child.pid : null, since: r ? r.since : null, script: r ? r.script : null, urls: r ? [...r.urls] : [] }
}

function view(ctx) {
  return projects(ctx).map((p) => ({ ...p, exists: fs.existsSync(path.join(p.path, 'package.json')), ...status(p.id) }))
}

function pushLine(ctx, id, text, kind) {
  const entry = running.get(id)
  const clean = text.replace(ANSI, '')
  const lines = logs.get(id) || []
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.replace(/\r/g, '').trimEnd()
    if (!line) continue
    lines.push(line)
    if (entry) {
      for (const m of line.match(URL_RE) || []) {
        if (!entry.urls.has(m)) {
          entry.urls.add(m)
          ctx.emit('url', { id, url: m })
        }
      }
    }
  }
  if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES)
  logs.set(id, lines)
  ctx.emit('log', { id, text: clean, kind })
}

function stopTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => resolve())
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        // already gone
      }
      resolve()
    }
  })
}

module.exports = {
  async dispose() {
    await Promise.all([...running.keys()].map((id) => stopTree(running.get(id).child.pid)))
    running.clear()
  },

  handlers: {
    async list(_args, ctx) {
      return { projects: view(ctx), node: findNode() }
    },

    async add({ folder }, ctx) {
      if (!ctx.isAllowed(folder)) throw new Error('Pick the project folder first')
      let info
      try {
        info = readPackage(folder)
      } catch {
        throw new Error('That folder has no readable package.json')
      }
      const list = projects(ctx)
      if (list.some((p) => path.resolve(p.path) === path.resolve(folder))) throw new Error('That project is already in the list')
      const project = { id: `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, path: folder, name: info.name, description: info.description, scripts: info.scripts, script: defaultScript(info.scripts) }
      ctx.settings.set({ projects: [...list, project] })
      ctx.allow(folder)
      return view(ctx)
    },

    /** Folders with a package.json near the usual places, not yet in the list. */
    async scan(_args, ctx) {
      const home = os.homedir()
      const roots = [path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop'), path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Documents'), path.join(home, 'Desktop', 'Files'), path.join(home, 'OneDrive', 'Desktop', 'Files')]
      const known = new Set(projects(ctx).map((p) => path.resolve(p.path).toLowerCase()))
      const found = []
      const seen = new Set()
      const look = (dir, depth) => {
        let entries
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
          const full = path.join(dir, e.name)
          const key = path.resolve(full).toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          if (fs.existsSync(path.join(full, 'package.json'))) {
            if (!known.has(key)) {
              try {
                const info = readPackage(full)
                if (info.scripts.length) found.push({ path: full, name: info.name, scripts: info.scripts, script: defaultScript(info.scripts) })
              } catch {
                // unreadable package.json: skip
              }
            }
          } else if (depth > 0) look(full, depth - 1)
        }
      }
      for (const root of roots) look(root, 1)
      return found.slice(0, 60)
    },

    async addMany({ folders }, ctx) {
      const list = projects(ctx)
      for (const folder of folders || []) {
        try {
          const info = readPackage(folder)
          if (list.some((p) => path.resolve(p.path) === path.resolve(folder))) continue
          list.push({ id: `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, path: folder, name: info.name, description: info.description, scripts: info.scripts, script: defaultScript(info.scripts) })
          ctx.allow(folder)
        } catch {
          // skip
        }
      }
      ctx.settings.set({ projects: list })
      return view(ctx)
    },

    async remove({ id }, ctx) {
      if (running.has(id)) await module.exports.handlers.stop({ id }, ctx)
      ctx.settings.set({ projects: projects(ctx).filter((p) => p.id !== id) })
      logs.delete(id)
      return view(ctx)
    },

    async setScript({ id, script }, ctx) {
      ctx.settings.set({ projects: projects(ctx).map((p) => (p.id === id ? { ...p, script: String(script) } : p)) })
      return view(ctx)
    },

    async refresh({ id }, ctx) {
      const list = projects(ctx)
      const p = list.find((x) => x.id === id)
      if (!p) throw new Error('Unknown project')
      const info = readPackage(p.path)
      Object.assign(p, { name: info.name, scripts: info.scripts, description: info.description, script: info.scripts.includes(p.script) ? p.script : defaultScript(info.scripts) })
      ctx.settings.set({ projects: list })
      return view(ctx)
    },

    async log({ id }) {
      if (!ID_RE.test(String(id))) throw new Error('Bad id')
      return { lines: logs.get(id) || [], ...status(id) }
    },

    async start({ id, script }, ctx) {
      if (!ID_RE.test(String(id))) throw new Error('Bad id')
      const p = projects(ctx).find((x) => x.id === id)
      if (!p) throw new Error('Unknown project')
      if (running.has(id)) throw new Error(`${p.name} is already running`)
      const name = String(script || p.script || '')
      if (!p.scripts.includes(name)) throw new Error(`"${name}" is not a script of ${p.name}`)
      const node = findNode()
      if (!node) throw new Error('node.exe was not found. Install Node.js from nodejs.org, then try again.')
      const npmCli = findNpmCli(node)
      if (!npmCli) throw new Error('npm was not found next to node.exe')

      logs.set(id, [])
      const child = spawn(node, [npmCli, 'run', name], {
        cwd: p.path,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ELECTRON_RUN_AS_NODE: undefined },
      })
      const entry = { child, since: Date.now(), urls: new Set(), script: name }
      running.set(id, entry)
      pushLine(ctx, id, `> npm run ${name}   (in ${p.path})`, 'system')
      child.stdout.on('data', (d) => pushLine(ctx, id, d.toString('utf8'), 'out'))
      child.stderr.on('data', (d) => pushLine(ctx, id, d.toString('utf8'), 'err'))
      child.on('error', (err) => pushLine(ctx, id, `could not start: ${err.message}`, 'err'))
      child.on('exit', (code, signal) => {
        if (running.get(id) === entry) running.delete(id)
        pushLine(ctx, id, `> exited ${signal ? `(${signal})` : `with code ${code}`}`, 'system')
        ctx.emit('exit', { id, code, signal })
      })
      return status(id)
    },

    async stop({ id }) {
      const entry = running.get(id)
      if (!entry) return status(id)
      await stopTree(entry.child.pid)
      running.delete(id)
      return status(id)
    },

    async openFolder({ id }, ctx) {
      const p = projects(ctx).find((x) => x.id === id)
      if (p) await shell.openPath(p.path)
    },

    async openUrl({ url }) {
      if (typeof url === 'string' && /^https?:\/\//.test(url)) await shell.openExternal(url)
    },
  },
}
