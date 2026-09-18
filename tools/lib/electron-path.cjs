// Where the Electron runtime lives. Normally node_modules/electron/dist; when that copy is missing
// (Avast quarantined it on 2026-09-17 and still blocks that exact path), the same version unpacked
// under %LOCALAPPDATA%\utility-electron\<version> is used instead, via the env var the `electron`
// package honours (ELECTRON_OVERRIDE_DIST_PATH). Require this before require('electron').
const fs = require('node:fs')
const path = require('node:path')

function runtimeDir() {
  const root = path.join(__dirname, '..', '..')
  const normal = path.join(root, 'node_modules', 'electron', 'dist')
  if (fs.existsSync(path.join(normal, 'electron.exe'))) return normal
  const version = require(path.join(root, 'node_modules', 'electron', 'package.json')).version
  const alt = path.join(process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'), 'utility-electron', version)
  if (fs.existsSync(path.join(alt, 'electron.exe'))) {
    process.env.ELECTRON_OVERRIDE_DIST_PATH = alt
    return alt
  }
  throw new Error(
    `Electron ${version} runtime not found.\n` +
      `  expected ${path.join(normal, 'electron.exe')}\n` +
      `  or       ${path.join(alt, 'electron.exe')}\n` +
      'Run "node node_modules/electron/install.js" (needs Avast to release that path), or unpack the cached\n' +
      `zip from %LOCALAPPDATA%\electron\Cache into ${alt}.`,
  )
}

/** Full path of electron.exe, and the env var set so require('electron') agrees. */
function electronExe() {
  return path.join(runtimeDir(), 'electron.exe')
}

module.exports = { runtimeDir, electronExe }
