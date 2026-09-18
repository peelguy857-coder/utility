// npm run shots [-- name-filter,...]: build the UI, run the app in screenshot mode, save PNGs.
//   UTILITY_SHOTS_OUT=<dir>   where the PNGs go (default .shots)
//   UTILITY_DIST=<dir>        build into / load from another folder (lets two runs happen at once)
//   UTILITY_SHOTS_NO_BUILD=1  reuse the existing build
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const root = path.join(__dirname, '..')
const dir = path.resolve(root, process.env.UTILITY_SHOTS_OUT || '.shots')
const dist = process.env.UTILITY_DIST || 'dist'
const only = process.argv.slice(2).join(',')

if (!process.env.UTILITY_SHOTS_NO_BUILD) {
  const build = spawnSync(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn', '--outDir', dist], {
    cwd: root,
    stdio: 'inherit',
  })
  if (build.status !== 0) process.exit(build.status ?? 1)
}

fs.rmSync(dir, { recursive: true, force: true })
const res = spawnSync(require('./lib/electron-path.cjs').electronExe(), ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, UTILITY_SHOTS_DIR: dir, UTILITY_SHOTS_ONLY: only, UTILITY_DIST: dist },
  timeout: 180000,
})
const logFile = path.join(dir, 'shots.log')
if (fs.existsSync(logFile)) process.stdout.write(fs.readFileSync(logFile, 'utf8'))
process.exit(res.status ?? 1)
