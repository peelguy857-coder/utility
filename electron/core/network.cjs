// "Can my phone reach this PC?" — read-only look at the things that usually say no:
// the Windows network profile (Public blocks incoming connections) and third-party firewalls.
// Nothing here changes a setting; the UI only tells the user where to look.
const { execFile } = require('node:child_process')
const os = require('node:os')

let cache = { at: 0, value: null }

function powershell(script, timeout = 8000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)))
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
  const result = { platform: process.platform, hostname: os.hostname(), networks: [], firewalls: [], problems: [] }
  if (process.platform === 'win32') {
    const [profiles, products] = await Promise.all([
      powershell('Get-NetConnectionProfile | Select-Object Name, InterfaceAlias, @{n="Category";e={"$($_.NetworkCategory)"}} | ConvertTo-Json -Compress'),
      powershell('Get-CimInstance -Namespace root/SecurityCenter2 -ClassName FirewallProduct | Select-Object displayName, productState | ConvertTo-Json -Compress'),
    ])
    result.networks = parseJson(profiles).map((p) => ({ name: String(p.Name ?? ''), adapter: String(p.InterfaceAlias ?? ''), category: String(p.Category ?? '') }))
    // productState is a bit field; 0x1000 in the middle byte means the product is switched on
    result.firewalls = parseJson(products)
      .filter((p) => (Number(p.productState) & 0x1000) !== 0)
      .map((p) => String(p.displayName ?? ''))

    for (const net of result.networks) {
      if (/public/i.test(net.category)) {
        result.problems.push({
          id: 'public-network',
          title: `Windows treats “${net.name}” as a Public network`,
          detail: 'On Public networks Windows hides this PC, so a phone on the same Wi-Fi cannot connect. Set the network to Private (only do this on a network you trust, like home).',
          action: { label: 'Open Wi-Fi settings', url: /wi-?fi|wlan/i.test(net.adapter) ? 'ms-settings:network-wifi' : 'ms-settings:network-ethernet' },
        })
      }
    }
    for (const name of result.firewalls) {
      result.problems.push({
        id: 'third-party-firewall',
        title: `${name} is running its own firewall`,
        detail: `If the phone cannot connect, open ${name} → Firewall, mark this Wi-Fi as trusted/private, and allow “Utility” (electron.exe) when it asks.`,
      })
    }
  }
  cache = { at: Date.now(), value: result }
  return result
}

module.exports = { check }
