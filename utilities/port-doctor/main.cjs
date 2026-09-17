// Port Doctor backend: reads the Windows port table, names the owning processes, ends one on request.
// Everything is spawned with an argument array (never a shell string) and with a timeout; nothing here
// blocks the main process.
'use strict'
const { execFile } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')
const lib = require('./lib/netstat.cjs')

const SYSTEM32 = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32')
const NETSTAT = path.join(SYSTEM32, 'netstat.exe')
const TASKLIST = path.join(SYSTEM32, 'tasklist.exe')
const TASKKILL = path.join(SYSTEM32, 'taskkill.exe')
const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** Every child process and test socket that is alive right now, so dispose() can clean up. */
const children = new Set()
const servers = new Set()
let disposed = false

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function assertSupported() {
  if (process.platform !== 'win32') throw new Error('Port Doctor reads the Windows port table. This system is not supported yet.')
  if (disposed) throw new Error('The app is closing')
}

/** Run a program to the end. Resolves with its exit code and output; rejects only when it could not run or timed out. */
function run(file, args, timeout = 10000, input = null) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      children.delete(child)
      const tool = path.basename(file)
      if (err && err.killed) return reject(new Error(`${tool} did not answer within ${Math.round(timeout / 1000)} s`))
      if (err && typeof err.code === 'string') return reject(new Error(`Could not start ${tool}: ${err.code === 'ENOENT' ? 'it is missing from this Windows installation' : err.message}`))
      resolve({ code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
    children.add(child)
    if (input != null) child.stdin.end(input)
  })
}

/**
 * PowerShell 5.1 with the script as one plain, readable -Command argument (execFile quotes it correctly,
 * newlines and double quotes included). Deliberately NOT "-ExecutionPolicy Bypass -EncodedCommand <base64>":
 * an unsigned program that launches PowerShell that way looks exactly like malware to behaviour-based
 * antivirus — Avast quarantined the app's runtime as IDP.Generic on 2026-09-17 while this did that.
 */
function runPowerShell(script, timeout) {
  return run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8\n" + script], timeout)
}

// ---------------------------------------------------------------- this app's own processes

/** Parent, grandparent, … of this app: looked up once, in the background (it takes a second). */
let ancestorsPromise = null
let ancestors = null

function loadAncestors() {
  if (!ancestorsPromise) {
    ancestorsPromise = (async () => {
      try {
        const res = await runPowerShell(
          "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ForEach-Object { [pscustomobject]@{ p=[int]$_.ProcessId; pp=[int]$_.ParentProcessId; n=$_.Name; c=$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }) } } | ConvertTo-Json -Compress",
          20000,
        )
        const chain = lib.ancestorsOf(lib.parseProcessTable(res.stdout), process.pid)
        ancestors = chain.length ? chain : [{ pid: process.ppid, name: '' }]
      } catch {
        ancestors = [{ pid: process.ppid, name: '' }] // at least the direct parent
      }
      return ancestors
    })()
  }
  return ancestorsPromise
}

/** PIDs that must never be ended from here: this process, Electron's helper processes, and whoever launched us. */
function selfPids(procs) {
  const set = new Set([process.pid])
  // under plain Node (self-test) there are no helper processes, and require('electron') must not run there
  if (process.versions.electron) for (const m of require('electron').app.getAppMetrics()) set.add(m.pid)
  for (const a of ancestors || [{ pid: process.ppid, name: '' }]) {
    // A recorded ancestor may have exited and its PID been re-used: only trust it while the name still matches.
    const now = procs && procs.get(a.pid)
    if (!a.name || !procs || (now && now.name.toLowerCase() === a.name.toLowerCase())) set.add(a.pid)
  }
  return set
}

// ---------------------------------------------------------------- snapshot

let inflight = null

/** One look at the system: every socket row plus the process names. Concurrent callers share the same run. */
function snapshot() {
  if (!inflight) {
    inflight = (async () => {
      const [ns, tl] = await Promise.all([run(NETSTAT, ['-ano']), run(TASKLIST, ['/FO', 'CSV', '/NH'])])
      const rows = lib.parseNetstat(ns.stdout)
      if (rows.length === 0) throw new Error('Windows returned an empty port table (netstat exit code ' + ns.code + ')' + (ns.stderr.trim() ? ': ' + ns.stderr.trim() : ''))
      return { rows, procs: lib.parseTasklistCsv(tl.stdout), takenAt: Date.now() }
    })().finally(() => {
      inflight = null
    })
  }
  return inflight
}

function tryBind(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer()
    servers.add(server)
    const finish = (result) => {
      servers.delete(server)
      resolve({ host, ...result })
    }
    server.once('error', (err) => finish({ ok: false, code: err.code || 'ERROR', message: err.message }))
    server.listen({ port, host, exclusive: true }, () => server.close(() => finish({ ok: true })))
  })
}

/** True once the process is gone (checked without spawning anything). */
function isGone(pid) {
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    return err.code === 'ESRCH'
  }
}

async function waitGone(pid, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (isGone(pid)) return true
    await sleep(120)
  }
  return isGone(pid)
}

function toPid(value) {
  const pid = Number(value)
  if (!Number.isInteger(pid) || pid < 0 || pid > 0xffffffff) throw new Error('That is not a process id')
  return pid
}

module.exports = {
  async init() {
    if (process.platform === 'win32') loadAncestors()
  },

  async dispose() {
    disposed = true
    for (const child of children) {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }
    children.clear()
    for (const server of servers) {
      try {
        server.close()
      } catch {
        // already closed
      }
    }
    servers.clear()
  },

  handlers: {
    /** Every listening TCP socket (and bound UDP socket when `udp`), grouped per port + process. */
    async list({ udp } = {}) {
      assertSupported()
      const snap = await snapshot()
      const rows = lib.groupListeners(snap.rows, snap.procs, { udp: !!udp, selfPids: selfPids(snap.procs) })
      return { rows, takenAt: snap.takenAt, sockets: snap.rows.length }
    },

    /** Executable, command line, parent … for one process. Slow (PowerShell + WMI), so only on demand. */
    async details({ pid: rawPid } = {}) {
      assertSupported()
      const pid = toPid(rawPid)
      const res = await runPowerShell(
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"
if (-not $p) { '{"missing":true}'; exit 0 }
$parent = $null
if ($p.ParentProcessId) { $parent = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ParentProcessId) }
if ($parent -and $p.CreationDate -and $parent.CreationDate -and ($parent.CreationDate -gt $p.CreationDate)) { $parent = $null }
$owner = $null
try { $o = Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop; if ($o.User) { $owner = $o.Domain + '\\' + $o.User } } catch {}
[pscustomobject]@{
  pid = [int]$p.ProcessId
  name = $p.Name
  path = $p.ExecutablePath
  commandLine = $p.CommandLine
  parentPid = [int]$p.ParentProcessId
  parentName = $(if ($parent) { $parent.Name } else { $null })
  started = $(if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') } else { $null })
  memory = [long]$p.WorkingSetSize
  threads = [int]$p.ThreadCount
  owner = $owner
} | ConvertTo-Json -Compress`,
        12000,
      )
      let data
      try {
        data = JSON.parse(res.stdout.trim())
      } catch {
        throw new Error('Windows did not return details for PID ' + pid + (res.stderr.trim() ? ': ' + res.stderr.trim().split(/\r?\n/)[0] : ''))
      }
      if (data.missing) throw new Error(`Process ${pid} is not running any more.`)
      return data
    },

    /**
     * End a process and its children. Refuses Windows' own processes, this app and whoever launched it;
     * svchost needs `confirmCritical: true` (the UI asks twice for that).
     */
    async kill({ pid: rawPid, confirmCritical } = {}) {
      assertSupported()
      const pid = toPid(rawPid)
      const snap = await snapshot()
      const proc = snap.procs.get(pid)
      if (!proc && isGone(pid)) return { ok: true, pid, name: '', alreadyGone: true }
      const name = proc ? proc.name : ''
      await loadAncestors()
      const policy = lib.killPolicy({ pid, name, selfPids: selfPids(snap.procs) })
      if (policy.level === 'never') throw new Error(policy.reason)
      if (policy.level === 'confirm' && confirmCritical !== true) throw new Error(policy.reason + ' Confirm a second time to end it anyway.')

      const res = await run(TASKKILL, ['/PID', String(pid), '/T', '/F'], 20000)
      if (await waitGone(pid, 3000)) return { ok: true, pid, name, alreadyGone: false }

      const said = (res.stderr.trim() || res.stdout.trim()).split(/\r?\n/).filter(Boolean).pop() || 'exit code ' + res.code
      const label = `${name || 'the process'} (PID ${pid})`
      if (res.code === 1 || /access|denied|verweigert|refus|denegado|negato|negado/i.test(said)) {
        throw new Error(`Windows refused to end ${label}: it needs administrator rights. Close Utility, start it with "Run as administrator" and try again. (${said})`)
      }
      throw new Error(`Could not end ${label}: ${said}`)
    },

    /**
     * Is TCP `port` free? Looks in the port table and also really binds it for a moment. The test bind
     * uses the loopback addresses only: listening on all interfaces would make Windows Firewall ask the
     * user for permission, and listeners on other addresses are in the port table anyway.
     */
    async checkPort({ port: rawPort } = {}) {
      assertSupported()
      const port = Number(rawPort)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('A port is a whole number from 1 to 65535')
      const snap = await snapshot()
      const owners = lib.ownersOfPort(lib.groupListeners(snap.rows, snap.procs, { selfPids: selfPids(snap.procs) }), port)
      const binds = []
      for (const host of ['127.0.0.1', '::1']) binds.push(await tryBind(port, host))
      // no IPv6 on this machine is not a verdict about the port
      const failed = binds.filter((b) => !b.ok && b.code !== 'EADDRNOTAVAIL' && b.code !== 'EAFNOSUPPORT' && b.code !== 'EINVAL')
      let status = 'free'
      if (owners.length) status = 'in-use'
      else if (failed.some((b) => b.code === 'EADDRINUSE')) status = 'in-use'
      else if (failed.some((b) => b.code === 'EACCES')) status = 'reserved'
      else if (failed.length) status = 'error'
      return { port, status, owners, binds, message: failed[0] ? failed[0].message : '' }
    },
  },
}
