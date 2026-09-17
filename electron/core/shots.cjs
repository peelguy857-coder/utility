// Screenshot run (npm run shots): walks through every screen, saves a PNG of each, quits.
// Used to check the UI without clicking through it by hand. Runs in a throwaway profile.
//
// A utility can add its own steps in utilities/<id>/test/shots.cjs:
//   module.exports = async (t) => {
//     t.queuePick(['C:/some/file.png'])      // what the next file/folder/save dialog will "return"
//     await t.clickText('Browse…')           // click a button by its text
//     await t.setInput('input[type=number]', '64')
//     await t.exec('document.title')         // run any JS in the page
//     await t.sleep(500)
//     await t.capture('loaded')              // -> NN-<id>--loaded.png
//   }
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { app, ipcMain } = require('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Paths the next pick-file / pick-folder / save-file calls return instead of opening a dialog. */
const pickQueue = []

async function capture(win, file) {
  for (let i = 0; i < 8; i++) {
    try {
      const img = await win.capturePage()
      if (!img.isEmpty()) {
        fs.writeFileSync(file, img.toPNG())
        return true
      }
    } catch {
      // "UnknownVizError" while the compositor is not ready yet: wait and retry
    }
    await sleep(300)
  }
  return false
}

function tools(win, dir, prefix, log) {
  const exec = (code) => win.webContents.executeJavaScript(code, true)
  return {
    win,
    sleep,
    exec,
    tmpDir: () => {
      const d = path.join(os.tmpdir(), 'utility-app', 'shots-work')
      fs.mkdirSync(d, { recursive: true })
      return d
    },
    queuePick: (paths) => pickQueue.push(...[].concat(paths)),
    /** Where capture(name) would write; for screenshots of windows the script opens itself. */
    shotPath: (name) => path.join(dir, `${prefix}--${name}.png`),
    capture: async (name) => {
      const ok = await capture(win, path.join(dir, `${prefix}--${name}.png`))
      log.push(`${ok ? 'ok  ' : 'FAIL'} ${prefix}--${name}`)
    },
    /** Click the first visible button/link whose text contains `text`. */
    clickText: (text) =>
      exec(`(() => {
        const want = ${JSON.stringify(text)}.toLowerCase()
        const el = [...document.querySelectorAll('.keepalive:not([hidden]) button, .keepalive:not([hidden]) [role=button], .keepalive:not([hidden]) a')]
          .find((b) => b.offsetParent !== null && (b.textContent || '').trim().toLowerCase().includes(want))
        if (!el) return false
        el.click()
        return true
      })()`),
    click: (selector) =>
      exec(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`),
    /** Set an <input>/<textarea> value the way React notices. */
    setInput: (selector, value) =>
      exec(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return false
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`),
    text: (selector) => exec(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`),
  }
}

async function run({ win, dir, utilitiesRoot }) {
  fs.mkdirSync(dir, { recursive: true })
  const only = (process.env.UTILITY_SHOTS_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean)
  const log = []
  const pageErrors = []
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') pageErrors.push(e.message)
  })
  try {
    const ready = new Promise((resolve) => ipcMain.once('core:ui-ready', (_e, info) => resolve(info)))
    const info = await Promise.race([ready, sleep(15000).then(() => null)])
    if (!info) throw new Error('UI never reported ready')
    win.setSize(1220, 800)
    win.showInactive()
    await sleep(400)

    const plan = [
      { name: '00-home-dark', steps: [['theme', 'dark'], ['route', { page: 'home' }]] },
      { name: '01-home-light', steps: [['theme', 'light'], ['route', { page: 'home' }]] },
      { name: '02-palette', steps: [['theme', 'dark'], ['route', { page: 'home' }], ['palette', true]] },
      { name: '03-settings', steps: [['palette', false], ['route', { page: 'settings' }]] },
      ...info.utilities.map((id, i) => ({
        name: `${String(10 + i)}-${id}`,
        id,
        steps: [['palette', false], ['theme', 'dark'], ['route', { page: 'utility', id }]],
      })),
    ].filter((p) => only.length === 0 || only.some((o) => p.name.includes(o)))

    for (const shot of plan) {
      for (const [command, payload] of shot.steps) win.webContents.send('core:command', command, payload)
      await sleep(900)
      const ok = await capture(win, path.join(dir, shot.name + '.png'))
      log.push(`${ok ? 'ok  ' : 'FAIL'} ${shot.name}`)

      const script = shot.id ? path.join(utilitiesRoot, shot.id, 'test', 'shots.cjs') : ''
      if (script && fs.existsSync(script)) {
        try {
          await require(script)(tools(win, dir, shot.name, log))
        } catch (err) {
          log.push(`FAIL ${shot.name} script: ${err.message}`)
        }
      }
    }
  } catch (err) {
    log.push('ERROR ' + err.message)
  }
  for (const msg of pageErrors.slice(0, 20)) log.push('page error: ' + msg)
  fs.writeFileSync(path.join(dir, 'shots.log'), log.join('\n') + '\n')
  app.exit(log.some((l) => l.startsWith('FAIL') || l.startsWith('ERROR')) ? 1 : 0)
}

module.exports = { run, pickQueue }
