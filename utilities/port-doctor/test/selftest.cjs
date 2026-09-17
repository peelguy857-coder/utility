// node utilities/port-doctor/test/selftest.cjs
// 1. the parsers against captured output (English + German Windows, IPv6, UDP)
// 2. on Windows: the real backend against a listener and a child process this test starts itself
'use strict'
const assert = require('node:assert/strict')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')
const lib = require('../lib/netstat.cjs')

let passed = 0
const pending = []
function test(name, fn) {
  pending.push(async () => {
    try {
      await fn()
      passed++
      console.log('  ok   ' + name)
    } catch (err) {
      console.log('  FAIL ' + name + '\n       ' + String(err && err.stack ? err.stack : err).split('\n').join('\n       '))
      process.exitCode = 1
    }
  })
}

// ---------------------------------------------------------------- captured output

const NETSTAT_EN = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2184
  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       18428
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       9120
  TCP    127.0.0.1:5354         127.0.0.1:49669        ESTABLISHED     10160
  TCP    127.0.0.1:49669        127.0.0.1:5354         ESTABLISHED     3796
  TCP    192.168.1.23:139       0.0.0.0:0              LISTENING       4
  TCP    192.168.1.23:50112     140.82.113.26:443      ESTABLISHED     7300
  TCP    192.168.1.23:50200     20.42.65.85:443        TIME_WAIT       0
  TCP    [::]:135               [::]:0                 LISTENING       2184
  TCP    [::]:3000              [::]:0                 LISTENING       18428
  TCP    [::]:25565             [::]:0                 LISTENING       22040
  TCP    [::1]:5173             [::]:0                 LISTENING       9120
  TCP    [::1]:49700            [::1]:5173             ESTABLISHED     7300
  UDP    0.0.0.0:123            *:*                                    18004
  UDP    0.0.0.0:5353           *:*                                    3796
  UDP    0.0.0.0:5353           *:*                                    20240
  UDP    127.0.0.1:1900         *:*                                    6432
  UDP    [::]:123               *:*                                    18004
  UDP    [fe80::88e9:8539:2f4d:81ae%16]:1900  *:*                                    6432
`

// German Windows: header and states are translated; the columns are not.
const NETSTAT_DE = `
Aktive Verbindungen

  Proto  Lokale Adresse         Remoteadresse          Status           PID
  TCP    0.0.0.0:135            0.0.0.0:0              ABHÖREN         1104
  TCP    0.0.0.0:8080           0.0.0.0:0              ABHÖREN         5512
  TCP    192.168.178.20:52133   52.113.194.132:443     HERGESTELLT     9044
  TCP    192.168.178.20:52140   20.189.173.4:443       WARTEND         0
  TCP    [::]:8080              [::]:0                 ABHÖREN         5512
  UDP    0.0.0.0:5050           *:*                                    7788
`

const TASKLIST_EN = `"System Idle Process","0","Services","0","8 K"
"System","4","Services","0","27,816 K"
"smss.exe","1220","Services","0","1,644 K"
"svchost.exe","2184","Services","0","18,120 K"
"node.exe","18428","Console","1","96,204 K"
"node.exe","9120","Console","1","120,004 K"
"java.exe","22040","Console","1","2,204,116 K"
"My ""odd"", app.exe","7300","Console","1","1,024 K"
`

const TASKLIST_DE = `"System","4","Services","0","27.816 K"
"node.exe","5512","Console","1","96.204 K"
`

// ---------------------------------------------------------------- parsers

test('splitEndpoint: IPv4, IPv6, zone id, wildcard', () => {
  assert.deepEqual(lib.splitEndpoint('0.0.0.0:135'), { host: '0.0.0.0', port: 135, family: 4 })
  assert.deepEqual(lib.splitEndpoint('127.0.0.1:5173'), { host: '127.0.0.1', port: 5173, family: 4 })
  assert.deepEqual(lib.splitEndpoint('[::]:3000'), { host: '::', port: 3000, family: 6 })
  assert.deepEqual(lib.splitEndpoint('[::1]:5173'), { host: '::1', port: 5173, family: 6 })
  assert.deepEqual(lib.splitEndpoint('[fe80::88e9:8539:2f4d:81ae%16]:1900'), { host: 'fe80::88e9:8539:2f4d:81ae%16', port: 1900, family: 6 })
  assert.deepEqual(lib.splitEndpoint('*:*'), { host: '*', port: null, family: 4 })
  assert.equal(lib.splitEndpoint('garbage'), null)
  assert.equal(lib.splitEndpoint('1.2.3.4:99999'), null)
  assert.equal(lib.splitEndpoint('1.2.3.4:http'), null)
})

test('parseNetstat: every socket row, header and blank lines skipped', () => {
  const rows = lib.parseNetstat(NETSTAT_EN)
  assert.equal(rows.length, 20)
  assert.equal(rows.filter((r) => r.proto === 'TCP').length, 14)
  assert.equal(rows.filter((r) => r.proto === 'UDP').length, 6)
  const first = rows[0]
  assert.deepEqual(first, { proto: 'TCP', family: 4, address: '0.0.0.0', port: 135, foreign: '0.0.0.0:0', state: 'LISTENING', pid: 2184, listening: true })
})

test('parseNetstat: only real listeners are marked listening', () => {
  const rows = lib.parseNetstat(NETSTAT_EN)
  const tcpListening = rows.filter((r) => r.proto === 'TCP' && r.listening)
  assert.deepEqual(
    tcpListening.map((r) => `${r.address}:${r.port}`),
    ['0.0.0.0:135', '0.0.0.0:445', '0.0.0.0:3000', '127.0.0.1:5173', '192.168.1.23:139', ':::135', ':::3000', ':::25565', '::1:5173'],
  )
  assert.ok(rows.filter((r) => r.state === 'ESTABLISHED' || r.state === 'TIME_WAIT').every((r) => !r.listening))
  assert.ok(rows.filter((r) => r.proto === 'UDP').every((r) => r.listening && r.state === ''))
})

test('parseNetstat: UDP on a link-local IPv6 address with a zone id', () => {
  const row = lib.parseNetstat(NETSTAT_EN).find((r) => r.address.startsWith('fe80'))
  assert.equal(row.port, 1900)
  assert.equal(row.pid, 6432)
  assert.equal(row.family, 6)
})

test('parseNetstat: German Windows (translated states) gives the same listeners', () => {
  const rows = lib.parseNetstat(NETSTAT_DE)
  assert.equal(rows.length, 6)
  assert.deepEqual(
    rows.filter((r) => r.proto === 'TCP' && r.listening).map((r) => `${r.address}:${r.port}/${r.pid}`),
    ['0.0.0.0:135/1104', '0.0.0.0:8080/5512', ':::8080/5512'],
  )
  assert.equal(rows[0].state, 'ABHÖREN')
})

test('parseNetstat: junk in, nothing out', () => {
  assert.deepEqual(lib.parseNetstat(''), [])
  assert.deepEqual(lib.parseNetstat(null), [])
  assert.deepEqual(lib.parseNetstat('TCP banana\nUDP\n  TCP    0.0.0.0:80   0.0.0.0:0   LISTENING   notapid'), [])
})

test('parseTasklistCsv: names, quoted commas, localized memory', () => {
  const procs = lib.parseTasklistCsv(TASKLIST_EN)
  assert.equal(procs.size, 8)
  assert.deepEqual(procs.get(4), { name: 'System', memoryKb: 27816 })
  assert.equal(procs.get(18428).name, 'node.exe')
  assert.equal(procs.get(22040).memoryKb, 2204116)
  assert.equal(procs.get(7300).name, 'My "odd", app.exe')
  assert.equal(lib.parseTasklistCsv(TASKLIST_DE).get(5512).memoryKb, 96204)
  assert.equal(lib.parseTasklistCsv('INFO: No tasks are running which match the specified criteria.').size, 0)
})

test('groupListeners: IPv4 + IPv6 of the same server become one row', () => {
  const groups = lib.groupListeners(lib.parseNetstat(NETSTAT_EN), lib.parseTasklistCsv(TASKLIST_EN))
  const p3000 = groups.filter((g) => g.port === 3000)
  assert.equal(p3000.length, 1)
  assert.deepEqual(p3000[0].addresses, ['0.0.0.0', '::'])
  assert.equal(p3000[0].name, 'node.exe')
  assert.equal(p3000[0].scope, 'lan')
  assert.equal(p3000[0].key, 'TCP:3000:18428')
  const vite = groups.find((g) => g.port === 5173)
  assert.deepEqual(vite.addresses, ['127.0.0.1', '::1'])
  assert.equal(vite.scope, 'local')
  assert.equal(groups.find((g) => g.port === 25565).name, 'java.exe')
  assert.equal(groups.find((g) => g.port === 139).scope, 'lan') // bound to one real interface
})

test('groupListeners: sorted by port, UDP only when asked', () => {
  const rows = lib.parseNetstat(NETSTAT_EN)
  const procs = lib.parseTasklistCsv(TASKLIST_EN)
  const tcp = lib.groupListeners(rows, procs)
  assert.ok(tcp.every((g) => g.proto === 'TCP'))
  assert.deepEqual(tcp.map((g) => g.port), [135, 139, 445, 3000, 5173, 25565])
  const all = lib.groupListeners(rows, procs, { udp: true })
  assert.equal(all.filter((g) => g.proto === 'UDP').length, 4) // 123 (v4+v6 merged), 1900 (two addresses), 5353 twice
  assert.deepEqual(all.find((g) => g.proto === 'UDP' && g.port === 123).addresses, ['0.0.0.0', '::'])
  assert.equal(all.filter((g) => g.proto === 'UDP' && g.port === 5353).length, 2) // two different owners stay apart
  const ssdp = all.find((g) => g.proto === 'UDP' && g.port === 1900)
  assert.deepEqual(ssdp.addresses, ['127.0.0.1', 'fe80::88e9:8539:2f4d:81ae%16'])
  assert.equal(ssdp.scope, 'lan')
})

test('groupListeners: protection flags', () => {
  const groups = lib.groupListeners(lib.parseNetstat(NETSTAT_EN), lib.parseTasklistCsv(TASKLIST_EN), { selfPids: new Set([9120]) })
  assert.equal(groups.find((g) => g.port === 445).protection, 'system')
  assert.equal(groups.find((g) => g.port === 135).protection, 'confirm') // svchost
  assert.equal(groups.find((g) => g.port === 5173).protection, 'self')
  assert.equal(groups.find((g) => g.port === 3000).protection, 'none')
})

test('ownersOfPort', () => {
  const groups = lib.groupListeners(lib.parseNetstat(NETSTAT_EN), lib.parseTasklistCsv(TASKLIST_EN), { udp: true })
  assert.deepEqual(lib.ownersOfPort(groups, 3000).map((g) => g.pid), [18428])
  assert.deepEqual(lib.ownersOfPort(groups, 5353), []) // UDP only: TCP 5353 is free
  assert.deepEqual(lib.ownersOfPort(groups, 3001), [])
})

test('killPolicy: refuses the kernel, core processes and the app itself', () => {
  const never = (pid, name, selfPids) => assert.equal(lib.killPolicy({ pid, name, selfPids }).level, 'never', `${name} ${pid}`)
  never(0, 'System Idle Process')
  never(4, 'System')
  never(4, 'renamed.exe')
  for (const name of ['csrss.exe', 'CSRSS.EXE', 'wininit.exe', 'services.exe', 'lsass.exe', 'smss.exe', 'winlogon.exe', 'Registry', 'Secure System']) never(812, name)
  never(5000, 'electron.exe', new Set([5000]))
  never(-1, 'x')
  never(1.5, 'x')
  assert.equal(lib.killPolicy({ pid: 2184, name: 'svchost.exe' }).level, 'confirm')
  assert.equal(lib.killPolicy({ pid: 18428, name: 'node.exe' }).level, 'ok')
  assert.equal(lib.killPolicy({ pid: 22040, name: 'java.exe', selfPids: new Set([1, 2]) }).level, 'ok')
  assert.equal(lib.killPolicy({ pid: 900, name: '' }).level, 'ok')
  assert.match(lib.killPolicy({ pid: 812, name: 'lsass.exe' }).reason, /core Windows process/)
})

test('parseProcessTable + ancestorsOf: parent chain, stops at a re-used PID', () => {
  const json = JSON.stringify([
    { p: 100, pp: 4, n: 'explorer.exe', c: '2026-01-01T08:00:00.0000000Z' },
    { p: 200, pp: 100, n: 'cmd.exe', c: '2026-01-01T09:00:00.0000000Z' },
    { p: 300, pp: 200, n: 'node.exe', c: '2026-01-01T09:05:00.0000000Z' },
    { p: 400, pp: 300, n: 'electron.exe', c: '2026-01-01T09:05:02.0000000Z' },
    { p: 500, pp: 9999, n: 'orphan.exe', c: '2026-01-01T09:00:00.0000000Z' },
    { p: 600, pp: 700, n: 'child.exe', c: '2026-01-01T09:00:00.0000000Z' },
    { p: 700, pp: 100, n: 'impostor.exe', c: '2026-01-01T10:00:00.0000000Z' }, // younger than its "child": PID re-use
  ])
  const table = lib.parseProcessTable(json)
  assert.equal(table.size, 7)
  assert.deepEqual(lib.ancestorsOf(table, 400), [{ pid: 300, name: 'node.exe' }, { pid: 200, name: 'cmd.exe' }, { pid: 100, name: 'explorer.exe' }])
  assert.deepEqual(lib.ancestorsOf(table, 500), [])
  assert.deepEqual(lib.ancestorsOf(table, 600), [])
  assert.deepEqual(lib.ancestorsOf(table, 12345), [])
  // a single process comes back from PowerShell as a bare object
  assert.equal(lib.parseProcessTable('{"p":1,"pp":0,"n":"a","c":null}').size, 1)
  assert.equal(lib.parseProcessTable('not json').size, 0)
  // a cycle must not hang
  const loop = lib.parseProcessTable(JSON.stringify([{ p: 1, pp: 2, n: 'a', c: null }, { p: 2, pp: 1, n: 'b', c: null }]))
  assert.deepEqual(lib.ancestorsOf(loop, 1), [{ pid: 2, name: 'b' }])
})

// ---------------------------------------------------------------- the real thing (Windows only)

if (process.platform === 'win32') {
  const backend = require('../main.cjs')
  const h = backend.handlers
  const listen = (host) =>
    new Promise((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.listen(0, host, () => resolve(server))
    })

  test('live: a listener started here shows up with this PID, and is protected', async () => {
    const server = await listen('127.0.0.1')
    try {
      const port = server.address().port
      const { rows } = await h.list({})
      const mine = rows.find((r) => r.port === port)
      assert.ok(mine, `port ${port} not in the list`)
      assert.equal(mine.pid, process.pid)
      assert.equal(mine.scope, 'local')
      assert.deepEqual(mine.addresses, ['127.0.0.1'])
      assert.match(mine.name, /node/i)
      assert.equal(mine.protection, 'self')
      await assert.rejects(h.kill({ pid: process.pid }), /Utility itself/)
    } finally {
      server.close()
    }
  })

  test('live: checkPort says who owns a taken port, and "free" once it is released', async () => {
    const server = await listen('127.0.0.1')
    const port = server.address().port
    const taken = await h.checkPort({ port })
    assert.equal(taken.status, 'in-use')
    assert.equal(taken.owners[0].pid, process.pid)
    assert.equal(taken.binds.find((b) => b.host === '127.0.0.1').code, 'EADDRINUSE')
    await new Promise((r) => server.close(r))
    const free = await h.checkPort({ port })
    assert.equal(free.status, 'free', JSON.stringify(free))
    await assert.rejects(h.checkPort({ port: 0 }), /1 to 65535/)
    await assert.rejects(h.checkPort({ port: 70000 }), /1 to 65535/)
    await assert.rejects(h.checkPort({ port: 'abc' }), /1 to 65535/)
  })

  test('live: refuses the kernel and nonsense', async () => {
    await assert.rejects(h.kill({ pid: 4 }), /kernel/)
    await assert.rejects(h.kill({ pid: 0 }), /kernel/)
    await assert.rejects(h.kill({ pid: 'abc; calc.exe' }), /not a process id/)
    await assert.rejects(h.kill({ pid: process.ppid }), /Utility itself/)
  })

  test('live: details for this process; ends a child it spawned; then reports it gone', async () => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'listen.cjs')], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
    try {
      const port = await new Promise((resolve, reject) => {
        child.stdout.once('data', (d) => resolve(Number(String(d).trim())))
        child.once('exit', () => reject(new Error('child exited early')))
      })
      const { rows } = await h.list({})
      const row = rows.find((r) => r.port === port)
      assert.ok(row, 'child listener not listed')
      assert.equal(row.pid, child.pid)
      assert.equal(row.protection, 'none')

      const info = await h.details({ pid: child.pid })
      assert.equal(info.pid, child.pid)
      assert.equal(info.parentPid, process.pid)
      assert.match(info.commandLine, /listen\.cjs/)
      assert.match(info.path, /node/i)

      const res = await h.kill({ pid: child.pid })
      assert.equal(res.ok, true)
      assert.equal(res.alreadyGone, false)
      const after = await h.list({})
      assert.ok(!after.rows.some((r) => r.port === port), 'port still listed after kill')
      const again = await h.kill({ pid: child.pid })
      assert.equal(again.alreadyGone, true)
      await assert.rejects(h.details({ pid: child.pid }), /not running any more/)
    } finally {
      child.kill()
    }
  })

  pending.push(() => backend.dispose())
}

;(async () => {
  for (const job of pending) await job()
  console.log(process.exitCode ? '\nport-doctor: FAILED' : `\nport-doctor: ${passed} checks passed`)
})()
