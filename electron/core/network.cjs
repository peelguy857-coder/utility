// "Can my phone reach this PC?" — a read-only look at the Windows network profile: on a Public
// network Windows hides the PC, so nothing on the Wi-Fi can connect to it.
// Nothing here changes a setting; the UI only tells the user where to look.
//
// Kept deliberately boring for antivirus heuristics: one plain PowerShell command, no execution-policy
// flags, no encoded command, and no querying of which security products are installed.
const { execFile } = require('node:child_process')
const os = require('node:os')

let cache = { at: 0, value: null }

function powershell(script, timeout = 8000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script], { timeout, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)))
  })
}

function parseJson(text) {
  try {
    const value = JSON.parse(text.trim() || 'null')
    return value == null ? [] : Array.isArray(value) ? value : [value]
  } catch {
    return []
  }
}

async function check({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < 20_000) return cache.value
  const result = { platform: process.platform, hostname: os.hostname(), networks: [], problems: [] }
  if (process.platform === 'win32') {
    const profiles = await powershell('Get-NetConnectionProfile | Select-Object Name, InterfaceAlias, @{n="Category";e={"$($_.NetworkCategory)"}} | ConvertTo-Json -Compress')
    result.networks = parseJson(profiles).map((p) => ({ name: String(p.Name ?? ''), adapter: String(p.InterfaceAlias ?? ''), category: String(p.Category ?? '') }))
    for (const net of result.networks) {
      if (!/public/i.test(net.category)) continue
      result.problems.push({
        id: 'public-network',
        title: `Windows treats “${net.name}” as a Public network`,
        detail:
          'On Public networks Windows hides this PC, so a phone on the same Wi-Fi cannot connect. Set the network to Private (only on a network you trust, like home). If you use an antivirus with its own firewall (Avast, Norton, …), mark the network as trusted/private there too.',
        action: { label: 'Open Wi-Fi settings', url: /wi-?fi|wlan/i.test(net.adapter) ? 'ms-settings:network-wifi' : 'ms-settings:network-ethernet' },
      })
    }
  }
  cache = { at: Date.now(), value: result }
  return result
}

module.exports = { check }
