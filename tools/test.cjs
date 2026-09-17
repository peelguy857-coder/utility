// npm test [-- id ...]: run every utilities/<id>/test/selftest.cjs with plain Node and summarise.
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const root = path.join(__dirname, '..')
const utilitiesDir = path.join(root, 'utilities')
const wanted = process.argv.slice(2)

const suites = fs
  .readdirSync(utilitiesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && (wanted.length === 0 || wanted.includes(d.name)))
  .map((d) => ({ id: d.name, file: path.join(utilitiesDir, d.name, 'test', 'selftest.cjs') }))
  .filter((s) => fs.existsSync(s.file))

if (suites.length === 0) {
  console.log('No self-tests found.')
  process.exit(0)
}

let failed = 0
for (const suite of suites) {
  const started = Date.now()
  console.log(`\n=== ${suite.id} ===`)
  const res = spawnSync(process.execPath, [suite.file], { cwd: root, stdio: 'inherit', timeout: 15 * 60 * 1000 })
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  if (res.status === 0) console.log(`--- ${suite.id}: passed in ${secs}s`)
  else {
    failed++
    console.log(`--- ${suite.id}: FAILED (exit ${res.status ?? res.signal}) after ${secs}s`)
  }
}

console.log(`\n${suites.length - failed}/${suites.length} suites passed`)
process.exit(failed ? 1 : 0)
