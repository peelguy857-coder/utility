// Pure parsing for Port Doctor: `netstat -ano`, `tasklist /FO CSV /NH`, and the process table that
// PowerShell prints as JSON. Nothing here touches the system, so it is unit-tested with captured output.
'use strict'

/**
 * '0.0.0.0:135' | '[::]:135' | '[fe80::1%16]:1900' | '*:*' -> { host, port, family }
 * `port` is null for '*'. Returns null when the text is not an endpoint.
 */
function splitEndpoint(text) {
  if (typeof text !== 'string') return null
  const i = text.lastIndexOf(':')
  if (i <= 0) return null
  let host = text.slice(0, i)
  const portText = text.slice(i + 1)
  let family = 4
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1)
    family = 6
  } else if (host.includes(':')) {
    family = 6
  }
  if (!host) return null
  if (portText === '*') return { host, port: null, family }
  if (!/^\d{1,5}$/.test(portText)) return null
  const port = Number(portText)
  if (port > 65535) return null
  return { host, port, family }
}

const isWildcardHost = (host) => host === '0.0.0.0' || host === '::' || host === '*'
const isLoopbackHost = (host) => /^127\./.test(host) || host === '::1'

/**
 * Parse `netstat -ano` (any mix of TCP / TCPv6 / UDP / UDPv6 sections).
 *
 * Locale independent: the header and the state words are translated on non-English Windows, so
 * neither is looked at. A TCP row is a listener when its foreign address is the "nobody yet"
 * address (0.0.0.0:0 or [::]:0); a UDP row has no state at all and is always a bound socket.
 */
function parseNetstat(text) {
  const rows = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/)
    if (tokens.length < 4) continue
    const proto = tokens[0].toUpperCase()
    if (proto !== 'TCP' && proto !== 'UDP') continue
    const pidText = tokens[tokens.length - 1]
    if (!/^\d+$/.test(pidText)) continue
    const local = splitEndpoint(tokens[1])
    if (!local || local.port == null) continue
    const foreign = splitEndpoint(tokens[2])
    const listening = proto === 'UDP' ? true : !!foreign && foreign.port === 0 && isWildcardHost(foreign.host)
    rows.push({
      proto,
      family: local.family,
      address: local.host,
      port: local.port,
      foreign: tokens[2],
      state: proto === 'TCP' ? tokens.slice(3, -1).join(' ') : '',
      pid: Number(pidText),
      listening,
    })
  }
  return rows
}

/** One CSV line -> fields. Handles quoted fields with commas and doubled quotes. */
function splitCsvLine(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else quoted = false
      } else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/** `tasklist /FO CSV /NH` -> Map(pid -> { name, memoryKb }). The memory column is localized ("27,816 K", "27.816 K"). */
function parseTasklistCsv(text) {
  const map = new Map()
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim().startsWith('"')) continue
    const f = splitCsvLine(line.trim())
    if (f.length < 2 || !/^\d+$/.test(f[1])) continue
    const digits = (f[4] || '').replace(/\D/g, '')
    map.set(Number(f[1]), { name: f[0], memoryKb: digits ? Number(digits) : null })
  }
  return map
}

// ---------------------------------------------------------------- who may be ended

const baseOf = (name) => String(name || '').trim().toLowerCase().replace(/\.exe$/, '')

/** Ending any of these takes Windows down (blue screen, forced sign-out or reboot). */
const CRITICAL = new Set(['system', 'system idle process', 'secure system', 'registry', 'memory compression', 'csrss', 'wininit', 'services', 'lsass', 'lsaiso', 'smss', 'winlogon'])
/** Usually survivable, but can take networking / audio / updates with it: ask twice. */
const RISKY = new Set(['svchost'])

/**
 * @returns {{ level: 'ok' | 'confirm' | 'never', reason: string }}
 *   ok      – a normal process
 *   confirm – allowed only after a second, explicit confirmation
 *   never   – refused, whatever the UI says
 */
function killPolicy({ pid, name, selfPids }) {
  if (!Number.isInteger(pid) || pid < 0) return { level: 'never', reason: 'That is not a process id.' }
  if (pid === 0 || pid === 4) return { level: 'never', reason: 'PID ' + pid + ' is the Windows kernel. It cannot be ended.' }
  if (selfPids && selfPids.has(pid)) return { level: 'never', reason: 'That is Utility itself (or the program that started it). Close the app instead.' }
  const base = baseOf(name)
  if (CRITICAL.has(base)) return { level: 'never', reason: (name || 'This process') + ' is a core Windows process. Ending it would crash or restart the PC.' }
  if (RISKY.has(base)) return { level: 'confirm', reason: (name || 'This process') + ' hosts Windows services (networking, audio, updates …). Ending it can break those until the next restart.' }
  return { level: 'ok', reason: '' }
}

// ---------------------------------------------------------------- grouping

/**
 * Listener rows -> one entry per (protocol, port, pid). The IPv4 and IPv6 halves of the same
 * server ("0.0.0.0:3000" + "[::]:3000") become a single row with both addresses.
 *
 * @param {ReturnType<typeof parseNetstat>} rows
 * @param {Map<number, { name: string }>} procs
 * @param {{ udp?: boolean, selfPids?: Set<number> }} [opts]
 */
function groupListeners(rows, procs, opts = {}) {
  const groups = new Map()
  for (const row of rows) {
    if (!row.listening) continue
    if (row.proto === 'UDP' && !opts.udp) continue
    const key = `${row.proto}:${row.port}:${row.pid}`
    let g = groups.get(key)
    if (!g) {
      const proc = procs.get(row.pid)
      const name = proc ? proc.name : row.pid === 0 ? 'System Idle Process' : row.pid === 4 ? 'System' : ''
      const policy = killPolicy({ pid: row.pid, name, selfPids: opts.selfPids })
      g = {
        key,
        proto: row.proto,
        port: row.port,
        pid: row.pid,
        name,
        addresses: [],
        scope: 'local',
        protection: opts.selfPids && opts.selfPids.has(row.pid) ? 'self' : policy.level === 'never' ? 'system' : policy.level === 'confirm' ? 'confirm' : 'none',
        protectionReason: policy.reason,
      }
      groups.set(key, g)
    }
    if (!g.addresses.some((a) => a.host === row.address)) g.addresses.push({ host: row.address, family: row.family })
    if (!isLoopbackHost(row.address)) g.scope = 'lan'
  }
  const list = [...groups.values()]
  for (const g of list) {
    g.addresses.sort((a, b) => a.family - b.family || a.host.localeCompare(b.host))
    g.addresses = g.addresses.map((a) => a.host)
  }
  list.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto) || a.pid - b.pid)
  return list
}

/** Who owns TCP `port`? Every listener group on that port (normally one). */
function ownersOfPort(groups, port) {
  return groups.filter((g) => g.proto === 'TCP' && g.port === port)
}

// ---------------------------------------------------------------- process tree

/** PowerShell's ConvertTo-Json prints a bare object instead of a one-item array; accept both. */
function parseProcessTable(jsonText) {
  const table = new Map()
  let data
  try {
    data = JSON.parse(String(jsonText || '').trim() || '[]')
  } catch {
    return table
  }
  for (const item of Array.isArray(data) ? data : [data]) {
    if (!item || !Number.isInteger(item.p)) continue
    const created = item.c ? Date.parse(item.c) : NaN
    table.set(item.p, { ppid: Number.isInteger(item.pp) ? item.pp : 0, name: item.n || '', created: Number.isFinite(created) ? created : null })
  }
  return table
}

/**
 * Parent, grandparent, … of `pid`. Windows re-uses process ids, so a "parent" that was created
 * after its child is somebody else who inherited the number: the walk stops there.
 */
function ancestorsOf(table, pid) {
  const chain = []
  const seen = new Set([pid])
  let cur = table.get(pid)
  while (cur && cur.ppid > 0 && !seen.has(cur.ppid)) {
    const parent = table.get(cur.ppid)
    if (!parent) break
    if (parent.created != null && cur.created != null && parent.created > cur.created) break
    chain.push({ pid: cur.ppid, name: parent.name })
    seen.add(cur.ppid)
    cur = parent
  }
  return chain
}

module.exports = { splitEndpoint, parseNetstat, splitCsvLine, parseTasklistCsv, killPolicy, groupListeners, ownersOfPort, parseProcessTable, ancestorsOf, isLoopbackHost, isWildcardHost }
