// Adds a throwaway project, starts its dev script through the real UI, checks the log and the URL
// button appear, stops it, and screenshots along the way. No cmd.exe involved.
const fs = require('node:fs')
const path = require('node:path')

module.exports = async (t) => {
  const work = path.join(t.tmpDir(), 'projects', 'demo-app')
  fs.rmSync(path.dirname(work), { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })
  fs.writeFileSync(
    path.join(work, 'package.json'),
    JSON.stringify(
      {
        name: 'demo-app',
        description: 'Throwaway project for the screenshot run',
        scripts: {
          build: 'node -e "console.log(1)"',
          dev: 'node -e "console.log(\'dev server ready on http://localhost:4321/\'); setInterval(() => console.log(\'tick\'), 400)"',
        },
        devDependencies: { vite: '*' },
      },
      null,
      2,
    ),
  )

  t.queuePick([work])
  if (!(await t.clickText('Add folder'))) throw new Error('no Add folder button')
  await t.sleep(800)
  const runline = await t.text('.keepalive:not([hidden]) .projects__runline')
  if (!runline.includes('npm run dev') || !/Web app/.test(runline)) throw new Error('did not recommend dev for a vite project: ' + runline)
  await t.capture('added')

  if (!(await t.clickText('Start'))) throw new Error('no Start button')
  for (let i = 0; i < 40 && !(await t.text('.keepalive:not([hidden]) .projects__log')).includes('tick'); i++) await t.sleep(250)
  const log = await t.text('.keepalive:not([hidden]) .projects__log')
  if (!log.includes('dev server ready')) throw new Error('no output from the child: ' + log.slice(0, 200))
  const actions = await t.text('.keepalive:not([hidden]) .projects__actions')
  if (!actions.includes('localhost:4321')) throw new Error('URL button missing: ' + actions)
  await t.capture('running')

  if (!(await t.clickText('Stop'))) throw new Error('no Stop button')
  for (let i = 0; i < 40 && !(await t.text('.keepalive:not([hidden]) .projects__log')).includes('exited'); i++) await t.sleep(250)
  if (!(await t.text('.keepalive:not([hidden]) .projects__log')).includes('exited')) throw new Error('child did not stop')
  await t.capture('stopped')

  await t.clickText('Other scripts')
  await t.sleep(300)
  await t.capture('scripts')
  await t.clickText('Remove')
  await t.sleep(400)
}
