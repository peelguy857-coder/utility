// Drives the real Port Doctor screen (npm run shots -- port-doctor).
// It ends exactly one process: a throwaway child that this script starts for that purpose.
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')

module.exports = async (t) => {
  const must = (ok, message) => {
    if (!ok) throw new Error(message)
  }
  const waitFor = async (what, fn, ms = 10000) => {
    const until = Date.now() + ms
    for (;;) {
      const value = await fn()
      if (value) return value
      if (Date.now() > until) throw new Error('timed out waiting for ' + what)
      await t.sleep(150)
    }
  }
  const rowText = (port) => t.exec(`(document.querySelector('.port-doctor__row[data-port="${port}"]') || {}).textContent || ''`)
  const theme = async (name) => {
    t.win.webContents.send('core:command', 'theme', name)
    await t.sleep(450)
  }

  let child = null
  let own = null
  try {
    await waitFor('the port table', () => t.exec(`document.querySelectorAll('.port-doctor__row').length > 0`))
    await t.capture('list')

    // 1. a listener inside this very app: listed, marked "this app", cannot be ended
    own = net.createServer()
    await new Promise((resolve, reject) => own.once('error', reject).listen(0, '127.0.0.1', resolve))
    const ownPort = own.address().port
    await t.clickText('Refresh')
    must(await t.setInput('.port-doctor__filter input', ':' + ownPort), 'filter box not found')
    const ownRow = await waitFor('own listener row', () => rowText(ownPort))
    must(/this app/i.test(ownRow), 'own listener is not marked "this app": ' + ownRow)
    must(ownRow.includes('PID ' + process.pid), 'own PID missing: ' + ownRow)
    must(await t.exec(`document.querySelector('.port-doctor__row[data-port="${ownPort}"] .btn--danger').disabled`), 'End process is enabled for the app itself')
    must((await t.exec(`document.querySelectorAll('.port-doctor__row').length`)) === 1, 'exact port filter shows more than one row')

    await t.setInput('#port-doctor-check', String(ownPort))
    await t.clickText('Check')
    const taken = await waitFor('"taken" verdict', async () => {
      const s = await t.text('.port-doctor__checkresult')
      return /is taken by/.test(s) ? s : ''
    })
    must(taken.includes('PID ' + process.pid), 'checker names the wrong owner: ' + taken)
    await t.capture('own-listener-taken')

    // 2. a child process started for this test: find it, look at it, end it through the UI
    child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'listen.cjs')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    const exited = new Promise((resolve) => child.once('exit', resolve))
    const childPort = await new Promise((resolve, reject) => {
      child.stdout.once('data', (d) => resolve(Number(String(d).trim())))
      child.once('exit', () => reject(new Error('test child exited before listening')))
      setTimeout(() => reject(new Error('test child never printed its port')), 8000)
    })
    await t.clickText('Refresh')
    await t.setInput('.port-doctor__filter input', ':' + childPort)
    const childRow = await waitFor('child listener row', () => rowText(childPort))
    must(childRow.includes('PID ' + child.pid), 'child PID missing: ' + childRow)
    must(/local/i.test(childRow) && childRow.includes('127.0.0.1'), 'child row should be a local 127.0.0.1 listener: ' + childRow)
    must(!(await t.exec(`document.querySelector('.port-doctor__row[data-port="${childPort}"] .btn--danger').disabled`)), 'End process is disabled for a normal process')

    await t.click(`.port-doctor__row[data-port="${childPort}"] .port-doctor__detailsbtn`)
    const details = await waitFor('process details', async () => {
      const s = await t.text('.port-doctor__details')
      return /listen\.cjs/.test(s) ? s : ''
    }, 20000)
    must(/Started by/.test(details) && details.includes('PID ' + process.pid), 'details do not name this app as the parent: ' + details)
    await t.capture('details')
    await theme('light')
    await t.capture('details-light')
    await theme('dark')

    // ask, cancel, ask again, confirm
    await t.click(`.port-doctor__row[data-port="${childPort}"] .btn--danger`)
    const question = await waitFor('inline confirmation', () => t.text('.port-doctor__confirm'))
    must(question.includes('PID ' + child.pid), 'confirmation is about another process: ' + question)
    await t.capture('confirm')
    await t.clickText('Cancel')
    await t.sleep(200)
    must(!(await t.text('.port-doctor__confirm')), 'Cancel did not close the confirmation')
    must(child.exitCode === null, 'child died although the confirmation was cancelled')

    await t.click(`.port-doctor__row[data-port="${childPort}"] .btn--danger`)
    const again = await waitFor('inline confirmation', () => t.text('.port-doctor__confirm'))
    must(again.includes('PID ' + child.pid) && (await t.exec(`document.querySelectorAll('.port-doctor__confirm').length`)) === 1, 'refusing to confirm: not exactly the test child')
    await t.click('.port-doctor__confirmbtns .btn--danger')
    await waitFor('the row to disappear', async () => !(await rowText(childPort)))
    await Promise.race([exited, t.sleep(5000)])
    must(child.exitCode !== null || child.signalCode !== null, 'the UI said ended, but the child is still running')
    const toast = await waitFor('result toast', () => t.text('.toast--ok'))
    must(toast.includes('Ended') && toast.includes(String(child.pid)), 'unexpected toast: ' + toast)
    const empty = await t.text('.port-doctor .empty')
    must(/Nothing is listening/.test(empty), 'no empty state after the last match vanished: ' + empty)
    await t.capture('ended')

    // 3. free again: the app's own listener closes, the checker agrees
    await new Promise((resolve) => own.close(resolve))
    own = null
    await t.setInput('#port-doctor-check', String(ownPort))
    await t.clickText('Check')
    await waitFor('"free" verdict', async () => /is free/.test(await t.text('.port-doctor__checkresult')))
    await t.capture('check-free')

    // 4. UDP on, then the minimum window size
    await t.setInput('.port-doctor__filter input', '')
    await t.clickText('TCP + UDP')
    await waitFor('UDP rows', () => t.exec(`[...document.querySelectorAll('.port-doctor__proto')].some((el) => el.textContent.trim() === 'UDP')`))
    await t.clickText('TCP')
    t.win.setSize(940, 600)
    await t.sleep(600)
    const overflow = await t.exec(`(() => {
      const main = document.querySelector('.main')
      const wide = [...document.querySelectorAll('.port-doctor__row, .port-doctor__head, .port-doctor__check')].filter((el) => el.scrollWidth > el.clientWidth + 1)
      return { page: main.scrollWidth - main.clientWidth, rows: wide.length }
    })()`)
    must(overflow.page <= 0 && overflow.rows === 0, 'overflows at 940x600: ' + JSON.stringify(overflow))
    await t.capture('min-size')
  } finally {
    t.win.setSize(1220, 800)
    t.win.webContents.send('core:command', 'theme', 'dark')
    if (own) own.close()
    if (child && child.exitCode === null) child.kill()
    await t.sleep(300)
  }
}
