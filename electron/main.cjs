// Main process: one window, a small set of "core" services the UI can call, and the
// router that forwards everything else to the matching utilities/<id>/main.cjs backend.
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, clipboard, nativeImage, session, Menu } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { Settings } = require('./core/settings.cjs')
const { Registry } = require('./core/registry.cjs')

const ROOT = path.join(__dirname, '..')
const DEV_URL = process.env.UTILITY_DEV_URL || ''
const SHOTS_DIR = process.env.UTILITY_SHOTS_DIR || ''
const MAX_READ_BYTES = 256 * 1024 * 1024

const DIST_DIR = path.resolve(ROOT, process.env.UTILITY_DIST || 'dist')

// Screenshot runs get a throwaway profile so they can never touch real settings,
// and skip the single-instance lock so they work while the real app is open.
if (SHOTS_DIR) {
  app.setPath('userData', path.join(os.tmpdir(), 'utility-app', 'shots-profile-' + process.pid))
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
}

/** @type {BrowserWindow | null} */
let win = null
/** @type {Settings} */
let settings
/** @type {Registry} */
let registry

// Files the user has explicitly handed to the app (picked in a dialog or dropped on the
// window). The generic read/write services only touch these.
const allowedPaths = new Set()
const allow = (p) => {
  if (typeof p === 'string' && p) allowedPaths.add(path.resolve(p))
  return p
}
const isAllowed = (p) => {
  if (typeof p !== 'string' || !p) return false
  const full = path.resolve(p)
  if (allowedPaths.has(full)) return true
  // anything inside an allowed folder is allowed too
  for (const a of allowedPaths) if (full.startsWith(a + path.sep)) return true
  return false
}

function makeContext(id) {
  const dataDir = path.join(app.getPath('userData'), 'utilities', id)
  return {
    id,
    /** Push an event to this utility's UI. */
    emit(event, payload) {
      if (win && !win.isDestroyed()) win.webContents.send('util:event', id, event, payload)
    },
    /** Folder for this utility's own persistent files (created on demand). */
    dataDir() {
      fs.mkdirSync(dataDir, { recursive: true })
      return dataDir
    },
    tempDir() {
      const dir = path.join(app.getPath('temp'), 'utility-app', id)
      fs.mkdirSync(dir, { recursive: true })
      return dir
    },
    settings: {
      get: () => settings.getUtil(id),
      set: (patch) => settings.setUtil(id, patch),
    },
    window: () => (win && !win.isDestroyed() ? win : null),
    allow,
    isAllowed,
    appInfo: { name: app.getName(), version: app.getVersion() },
  }
}

// ---------------------------------------------------------------- window

const OVERLAY = {
  dark: { color: '#00000000', symbolColor: '#a3a9b8', height: 44 },
  light: { color: '#00000000', symbolColor: '#5b606c', height: 44 },
}

function applyTheme(theme) {
  nativeTheme.themeSource = theme === 'dark' || theme === 'light' ? theme : 'system'
  if (win && !win.isDestroyed() && process.platform === 'win32') {
    try {
      win.setTitleBarOverlay(nativeTheme.shouldUseDarkColors ? OVERLAY.dark : OVERLAY.light)
    } catch {
      // overlay not supported on this platform/window: ignore
    }
  }
}

function createWindow() {
  const bounds = settings.all().windowBounds || {}
  win = new BrowserWindow({
    width: bounds.width || 1220,
    height: bounds.height || 800,
    x: bounds.x,
    y: bounds.y,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0e12' : '#f4f4f1',
    title: 'Utility',
    icon: path.join(ROOT, 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: nativeTheme.shouldUseDarkColors ? OVERLAY.dark : OVERLAY.light,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => {
    if (!SHOTS_DIR) win.show()
  })
  win.on('close', () => {
    if (win && !win.isMaximized() && !win.isMinimized() && !SHOTS_DIR) settings.data.windowBounds = win.getBounds()
    settings.flush()
  })
  win.on('closed', () => {
    win = null
  })

  // The UI never navigates away from itself and never opens child windows.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (DEV_URL) win.loadURL(DEV_URL)
  else win.loadFile(path.join(DIST_DIR, 'index.html'))
}

// ---------------------------------------------------------------- ipc

function fromOurWindow(event) {
  return !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!fromOurWindow(event)) throw new Error('Blocked: unexpected sender')
    return fn(...args)
  })
}

// During a screenshot run no native dialog may open; they return what the test queued instead.
function shotsPick(max) {
  const { pickQueue } = require('./core/shots.cjs')
  return pickQueue.splice(0, max)
}

function registerIpc() {
  handle('util:invoke', (id, method, args) => registry.invoke(String(id), String(method), args))

  handle('core:app-info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    username: os.userInfo().username,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    backends: registry.list(),
    dev: !!DEV_URL,
  }))

  handle('core:settings-get', () => settings.all())
  handle('core:settings-set', (patch) => {
    const next = settings.set(patch || {})
    if (patch && 'theme' in patch) applyTheme(next.theme)
    return next
  })
  handle('core:util-settings-get', (id) => settings.getUtil(String(id)))
  handle('core:util-settings-set', (id, patch) => settings.setUtil(String(id), patch || {}))

  handle('core:pick-file', async (opts = {}) => {
    if (SHOTS_DIR) return shotsPick(opts.multi ? 99 : 1).map(allow)
    const res = await dialog.showOpenDialog(win, {
      title: opts.title,
      defaultPath: opts.defaultPath,
      filters: opts.filters,
      properties: ['openFile', ...(opts.multi ? ['multiSelections'] : [])],
    })
    return res.canceled ? [] : res.filePaths.map(allow)
  })
  handle('core:pick-folder', async (opts = {}) => {
    if (SHOTS_DIR) return shotsPick(1).map(allow)[0] ?? null
    const res = await dialog.showOpenDialog(win, {
      title: opts.title,
      defaultPath: opts.defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    })
    return res.canceled ? null : allow(res.filePaths[0])
  })
  handle('core:save-file', async (opts = {}) => {
    if (SHOTS_DIR) return shotsPick(1).map(allow)[0] ?? null
    const res = await dialog.showSaveDialog(win, { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters })
    return res.canceled || !res.filePath ? null : allow(res.filePath)
  })

  handle('core:file-info', async (p) => {
    if (!isAllowed(p)) throw new Error('That file was not shared with the app')
    const st = await fs.promises.stat(p)
    return { path: p, name: path.basename(p), ext: path.extname(p).toLowerCase(), size: st.size, mtime: st.mtimeMs, isDirectory: st.isDirectory() }
  })
  handle('core:read-file', async (p) => {
    if (!isAllowed(p)) throw new Error('That file was not shared with the app')
    const st = await fs.promises.stat(p)
    if (st.size > MAX_READ_BYTES) throw new Error('File is too large to load into the window')
    return fs.promises.readFile(p)
  })
  handle('core:write-file', async ({ path: p, data }) => {
    if (!isAllowed(p)) throw new Error('Pick where to save first')
    await fs.promises.mkdir(path.dirname(path.resolve(p)), { recursive: true }) // sub-folders of a picked folder
    await fs.promises.writeFile(p, Buffer.from(data))
    return { path: p, bytes: data.byteLength ?? data.length }
  })

  handle('core:reveal', (p) => {
    if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(path.resolve(p))
  })
  handle('core:open-path', (p) => (isAllowed(p) ? shell.openPath(path.resolve(p)) : 'not allowed'))
  handle('core:open-external', (url) => {
    // web links, plus Windows Settings pages (ms-settings:network-wifi) — nothing else
    if (typeof url === 'string' && (/^https?:\/\//i.test(url) || /^ms-settings:[a-z-]+$/i.test(url))) return shell.openExternal(url)
  })
  handle('core:network-check', (opts) => require('./core/network.cjs').check(opts || {}))
  handle('core:clipboard-write', ({ text, imageDataUrl }) => {
    if (typeof imageDataUrl === 'string') clipboard.writeImage(nativeImage.createFromDataURL(imageDataUrl))
    else clipboard.writeText(String(text ?? ''))
  })
  handle('core:clipboard-read', () => clipboard.readText())

  // Sent by the preload (not the page) whenever a real file is dropped on the window.
  ipcMain.on('core:allow-path', (event, p) => {
    if (fromOurWindow(event)) allow(p)
  })
}

// ---------------------------------------------------------------- lifecycle

// Groups the window under its own taskbar button (with our icon) instead of "Electron".
if (process.platform === 'win32') app.setAppUserModelId('com.peelguy857.utility')

app.whenReady().then(async () => {
  settings = new Settings(path.join(app.getPath('userData'), 'settings.json'))
  registry = new Registry({ root: path.join(ROOT, 'utilities'), makeContext })
  Menu.setApplicationMenu(null)
  applyTheme(settings.all().theme)

  // Only what the app itself needs; every other permission request is refused.
  const allowedPermissions = new Set(['clipboard-sanitized-write', 'fullscreen'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowedPermissions.has(permission)))

  registerIpc()
  createWindow()
  nativeTheme.on('updated', () => applyTheme(settings.all().theme))

  if (SHOTS_DIR) require('./core/shots.cjs').run({ win, dir: SHOTS_DIR, utilitiesRoot: path.join(ROOT, 'utilities') })

  // F12 / Ctrl+Shift+I for debugging, since there is no menu.
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) win.webContents.toggleDevTools()
  })
})

let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  quitting = true
  e.preventDefault()
  settings.flush()
  // give backends (servers, child processes) a moment to shut down cleanly
  Promise.race([registry.disposeAll(), new Promise((r) => setTimeout(r, 2500))]).finally(() => app.exit(0))
})

app.on('window-all-closed', () => app.quit())
