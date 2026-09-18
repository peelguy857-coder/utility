// npm run pack            -> release/Utility/            (portable folder, run Utility.exe)
// npm run install-app     -> %LOCALAPPDATA%\Programs\Utility + Desktop and Start Menu shortcuts
//
// The Electron runtime is copied byte-for-byte and only renamed. It is deliberately NOT patched
// (no icon/resource editing): Smart App Control judges executables by hash and reputation, and an
// unmodified Electron binary is one it already knows. The shortcut carries the custom icon instead.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const pkg = require(path.join(root, 'package.json'))
const install = process.argv.includes('--install')
const productName = pkg.productName || 'Utility'
const target = install ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', productName) : path.join(root, 'release', productName)

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
  if (res.status !== 0) process.exit(res.status ?? 1)
}

function copyUtilities(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const src = path.join(from, entry.name)
    if (!fs.existsSync(path.join(src, 'main.cjs'))) continue // UI-only utilities live entirely in the built renderer
    const dst = path.join(to, entry.name)
    fs.mkdirSync(dst, { recursive: true })
    fs.copyFileSync(path.join(src, 'main.cjs'), path.join(dst, 'main.cjs'))
    for (const extra of ['NOTICE.md', 'LICENSE']) if (fs.existsSync(path.join(src, extra))) fs.copyFileSync(path.join(src, extra), path.join(dst, extra))
    if (fs.existsSync(path.join(src, 'lib'))) {
      fs.cpSync(path.join(src, 'lib'), path.join(dst, 'lib'), { recursive: true, filter: (p) => !/\.(ts|tsx)$/.test(p) })
    }
  }
}

console.log('[pack] building the UI')
run(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'], { env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' } })

console.log('[pack] copying the Electron runtime to', target)
const runtime = require('./lib/electron-path.cjs').runtimeDir()
try {
  fs.rmSync(target, { recursive: true, force: true })
} catch (err) {
  console.error(`[pack] could not replace ${target} — is the app still running? (${err.code})`)
  process.exit(1)
}
fs.cpSync(runtime, target, { recursive: true })
fs.renameSync(path.join(target, 'electron.exe'), path.join(target, `${productName}.exe`))
fs.rmSync(path.join(target, 'resources', 'default_app.asar'), { force: true })

console.log('[pack] adding the app')
const appDir = path.join(target, 'resources', 'app')
fs.mkdirSync(appDir, { recursive: true })
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: pkg.name, productName, version: pkg.version, main: pkg.main, private: true }, null, 2))
fs.cpSync(path.join(root, 'electron'), path.join(appDir, 'electron'), { recursive: true })
fs.cpSync(path.join(root, 'dist'), path.join(appDir, 'dist'), { recursive: true })
fs.cpSync(path.join(root, 'assets'), path.join(appDir, 'assets'), { recursive: true })
copyUtilities(path.join(root, 'utilities'), path.join(appDir, 'utilities'))

if (install) {
  console.log('[pack] creating shortcuts')
  const exe = path.join(target, `${productName}.exe`)
  const icon = path.join(appDir, 'assets', 'icon.ico')
  // [Environment]::GetFolderPath respects a Desktop that OneDrive has redirected
  const script = [
    '$shell = New-Object -ComObject WScript.Shell',
    "$places = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))",
    'foreach ($place in $places) {',
    `  $link = $shell.CreateShortcut((Join-Path $place '${productName}.lnk'))`,
    `  $link.TargetPath = '${exe.replace(/'/g, "''")}'`,
    `  $link.WorkingDirectory = '${target.replace(/'/g, "''")}'`,
    `  $link.IconLocation = '${icon.replace(/'/g, "''")}'`,
    "  $link.Description = 'Utility - one app, many small tools'",
    '  $link.Save()',
    '}',
  ].join('\n')
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
}

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true, recursive: true }).reduce((n, e) => (e.isFile() ? n + fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size : n), 0)
console.log(`[pack] done: ${target} (${Math.round(size(target) / 1024 / 1024)} MB)`)
