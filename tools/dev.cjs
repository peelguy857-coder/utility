// npm run dev: start the Vite dev server, then Electron pointed at it (hot reload for the UI).
const { spawn } = require('node:child_process')
const path = require('node:path')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ root: path.join(__dirname, '..') })
  await server.listen()
  const url = server.resolvedUrls.local[0]
  console.log('[dev] UI at', url)

  const electron = require('./lib/electron-path.cjs').electronExe()
  const child = spawn(electron, ['.'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: { ...process.env, UTILITY_DEV_URL: url },
  })
  child.on('exit', async (code) => {
    await server.close()
    process.exit(code ?? 0)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
