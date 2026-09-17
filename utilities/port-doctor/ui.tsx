import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ArrowDown, ChevronDown, CircleCheck, CircleX, FolderOpen, Plug, RefreshCw, Search, ShieldAlert, Skull, TriangleAlert, X } from 'lucide-react'
import { core, errorMessage, useBackend } from '@/lib/bridge'
import { useIsActive } from '@/lib/active'
import { cx, formatBytes } from '@/lib/format'
import { useToast } from '@/components/Toasts'
import { Badge, Button, CopyButton, Empty, Notice, Panel, Segmented, Spinner, TextInput } from '@/components/ui'
import './ui.css'

interface PortRow {
  key: string
  proto: 'TCP' | 'UDP'
  port: number
  pid: number
  name: string
  addresses: string[]
  scope: 'lan' | 'local'
  protection: 'none' | 'confirm' | 'system' | 'self'
  protectionReason: string
}

interface ListResult {
  rows: PortRow[]
  takenAt: number
}

interface ProcessDetails {
  pid: number
  name: string
  path: string | null
  commandLine: string | null
  parentPid: number
  parentName: string | null
  started: string | null
  memory: number
  threads: number
  owner: string | null
}

type DetailState = { status: 'loading' } | { status: 'ready'; data: ProcessDetails } | { status: 'error'; message: string }

interface CheckResult {
  port: number
  status: 'free' | 'in-use' | 'reserved' | 'error'
  owners: PortRow[]
  binds: Array<{ host: string; ok: boolean; code?: string }>
  message: string
}

interface KillResult {
  ok: boolean
  pid: number
  name: string
  alreadyGone: boolean
}

const DEV_PORTS: Array<{ port: number; label?: string }> = [
  { port: 3000 },
  { port: 3001 },
  { port: 4200 },
  { port: 5000 },
  { port: 5173 },
  { port: 5317 },
  { port: 8000 },
  { port: 8080 },
  { port: 8787 },
  { port: 1420 },
  { port: 7000 },
  { port: 25565, label: 'Minecraft' },
  { port: 25575, label: 'RCON' },
]

const REFRESH_MS = 5000

/** "3000" = port starts with / pid equals, ":3000" = exactly that port, "pid:812", anything else = process name or address. All words must match. */
function matches(row: PortRow, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  return tokens.every((tok) => {
    if (tok.startsWith(':')) return tok.length === 1 || String(row.port) === tok.slice(1)
    if (tok.startsWith('pid:')) return tok.length === 4 || String(row.pid) === tok.slice(4)
    if (/^\d+$/.test(tok)) return String(row.port).startsWith(tok) || String(row.pid) === tok
    return row.name.toLowerCase().includes(tok) || row.proto.toLowerCase() === tok || row.scope === tok || row.addresses.some((a) => a.toLowerCase().includes(tok))
  })
}

const sameRows = (a: PortRow[] | null, b: PortRow[]) => !!a && a.length === b.length && JSON.stringify(a) === JSON.stringify(b)

function since(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (s < 90) return `${s} s ago`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ${m % 60} min ago`
  return `${Math.floor(h / 24)} days ago`
}

const processLabel = (row: { name: string; pid: number }) => `${row.name || 'unknown process'} (PID ${row.pid})`

export default function PortDoctor() {
  const api = useBackend('port-doctor')
  const toast = useToast()
  const active = useIsActive()

  const [rows, setRows] = useState<PortRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState('')
  const [udp, setUdp] = useState<'tcp' | 'all'>('tcp')
  const [sort, setSort] = useState<'port' | 'name'>('port')
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<number, DetailState>>({})
  const [confirm, setConfirm] = useState<{ key: string; step: 1 | 2 } | null>(null)
  const [killing, setKilling] = useState<string | null>(null)

  const [checkText, setCheckText] = useState('3000')
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState<CheckResult | null>(null)

  const filterRef = useRef<HTMLDivElement>(null)
  const seq = useRef(0)
  const udpRef = useRef(udp)
  udpRef.current = udp

  /** Reads the table again. Only the newest answer is applied, and an unchanged table keeps its identity (no re-render, no scroll jump). */
  const refresh = useCallback(
    async (manual = false): Promise<PortRow[] | null> => {
      const mine = ++seq.current
      if (manual) setRefreshing(true)
      try {
        const res = await api.invoke<ListResult>('list', { udp: udpRef.current === 'all' })
        if (mine !== seq.current) return res.rows
        setRows((prev) => (sameRows(prev, res.rows) ? prev : res.rows))
        setUpdatedAt(res.takenAt)
        setError(null)
        return res.rows
      } catch (err) {
        if (mine === seq.current) setError(errorMessage(err))
        if (manual) toast.error('Could not read the port table', { detail: errorMessage(err) })
        return null
      } finally {
        if (manual) setRefreshing(false)
      }
    },
    [api, toast],
  )

  // Refresh when the screen is shown, then every few seconds while it stays on screen.
  useEffect(() => {
    if (!active) return
    void refresh()
    const timer = window.setInterval(() => void refresh(), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [active, udp, refresh])

  // A row that vanished takes its pending confirmation with it.
  useEffect(() => {
    if (rows && confirm && !rows.some((r) => r.key === confirm.key)) setConfirm(null)
  }, [rows, confirm])

  // Ctrl+F jumps to the filter, Esc backs out of a pending confirmation.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        filterRef.current?.querySelector('input')?.focus()
      } else if (e.key === 'Escape') setConfirm(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  const visible = useMemo(() => {
    const list = (rows ?? []).filter((r) => matches(r, filter))
    if (sort === 'name') return [...list].sort((a, b) => (a.name || '~').localeCompare(b.name || '~') || a.port - b.port)
    return list
  }, [rows, filter, sort])

  const chips = useMemo(
    () => DEV_PORTS.map((d) => ({ ...d, row: rows?.find((r) => r.proto === 'TCP' && r.port === d.port) })).filter((c): c is { port: number; label?: string; row: PortRow } => !!c.row),
    [rows],
  )

  const loadDetails = useCallback(
    async (pid: number) => {
      setDetails((d) => ({ ...d, [pid]: { status: 'loading' } }))
      try {
        const data = await api.invoke<ProcessDetails>('details', { pid })
        setDetails((d) => ({ ...d, [pid]: { status: 'ready', data } }))
      } catch (err) {
        setDetails((d) => ({ ...d, [pid]: { status: 'error', message: errorMessage(err) } }))
        toast.error(`No details for PID ${pid}`, { detail: errorMessage(err) })
      }
    },
    [api, toast],
  )

  const toggleOpen = (row: PortRow) => {
    if (openKey === row.key) {
      setOpenKey(null)
      return
    }
    setOpenKey(row.key)
    void loadDetails(row.pid)
  }

  const endProcess = async (row: PortRow, confirmCritical: boolean) => {
    setKilling(row.key)
    try {
      const res = await api.invoke<KillResult>('kill', { pid: row.pid, confirmCritical })
      setConfirm(null)
      const after = await refresh()
      const still = after?.some((r) => r.pid === row.pid)
      if (still) toast.warn(`${processLabel(row)} is still listed`, { detail: 'Windows reported success, but the port is still held. Refresh in a moment.' })
      else if (res.alreadyGone) toast.info(`${processLabel(row)} had already exited`, { detail: `Port ${row.port} is free.` })
      else toast.ok(`Ended ${processLabel(row)}`, { detail: `Port ${row.port} is free again.` })
    } catch (err) {
      setConfirm(null)
      toast.error(`Could not end ${row.name || 'the process'}`, { detail: errorMessage(err) })
      void refresh()
    } finally {
      setKilling(null)
    }
  }

  const runCheck = async (text = checkText) => {
    const clean = text.trim()
    const port = Number(clean)
    if (!/^\d{1,5}$/.test(clean) || port < 1 || port > 65535) {
      toast.warn('Type a port number from 1 to 65535')
      return
    }
    setChecking(true)
    try {
      setCheck(await api.invoke<CheckResult>('checkPort', { port }))
      void refresh()
    } catch (err) {
      setCheck(null)
      toast.error(`Could not check port ${port}`, { detail: errorMessage(err) })
    } finally {
      setChecking(false)
    }
  }

  const showInTable = (port: number) => {
    setFilter(':' + port)
    setSort('port')
  }

  const moveFocus = (e: ReactKeyboardEvent<HTMLDivElement>, dir: 1 | -1) => {
    const all = Array.from(e.currentTarget.closest('.port-doctor__body')?.querySelectorAll<HTMLElement>('.port-doctor__row') ?? [])
    const next = all[all.indexOf(e.currentTarget) + dir]
    if (next) {
      e.preventDefault()
      next.focus()
    }
  }

  const filterIsPort = /^:?\d{1,5}$/.test(filter.trim()) && Number(filter.trim().replace(':', '')) >= 1 && Number(filter.trim().replace(':', '')) <= 65535
  const total = rows?.length ?? 0

  return (
    <div className="port-doctor">
      <Panel>
        <div className="port-doctor__check">
          <form
            className="port-doctor__checkform"
            onSubmit={(e) => {
              e.preventDefault()
              void runCheck()
            }}
          >
            <label className="port-doctor__checklabel" htmlFor="port-doctor-check">
              Is port
            </label>
            <TextInput id="port-doctor-check" className="port-doctor__checkinput" value={checkText} onChange={(v) => setCheckText(v.replace(/[^\d]/g, '').slice(0, 5))} mono inputMode="numeric" placeholder="3000" aria-label="Port number to check" />
            <span className="port-doctor__checklabel">free?</span>
            <Button variant="primary" icon={Plug} loading={checking} onClick={() => void runCheck()}>
              Check
            </Button>
          </form>
          <div className="port-doctor__checkresult" aria-live="polite">
            {!check ? (
              <span className="port-doctor__muted">Looks in the port table and really binds the port for a moment, so you know before your dev server says EADDRINUSE.</span>
            ) : check.status === 'free' ? (
              <Notice tone="ok" icon={CircleCheck} title={`Port ${check.port} is free`}>
                Nothing is listening on it and a test bind on localhost worked.
              </Notice>
            ) : check.status === 'in-use' ? (
              <Notice tone="error" icon={CircleX} title={check.owners.length ? `Port ${check.port} is taken by ${check.owners.map(processLabel).join(' and ')}` : `Port ${check.port} is taken`}>
                {check.owners.length ? (
                  <>
                    Listening on {check.owners.flatMap((o) => o.addresses).join(', ')}.{' '}
                    <button type="button" className="port-doctor__link" onClick={() => showInTable(check.port)}>
                      Show in the table
                    </button>
                  </>
                ) : (
                  'The test bind failed with "address in use", but no process shows up as its owner. It may be closing down: check again in a few seconds.'
                )}
              </Notice>
            ) : check.status === 'reserved' ? (
              <Notice tone="warn" icon={ShieldAlert} title={`Windows has reserved port ${check.port}`}>
                No process owns it, but apps are not allowed to bind it (usually a Hyper-V / WSL / Docker excluded range). Pick another port, or list the ranges with <code>netsh int ipv4 show excludedportrange protocol=tcp</code>.
              </Notice>
            ) : (
              <Notice tone="warn" icon={TriangleAlert} title={`Could not test port ${check.port}`}>
                {check.message || 'The test bind failed for an unknown reason.'}
              </Notice>
            )}
          </div>
        </div>
      </Panel>

      <Panel
        flush
        title="Listening ports"
        hint={
          rows == null
            ? 'Reading the port table…'
            : `${filter.trim() ? `${visible.length} of ${total}` : total} ${total === 1 ? 'listener' : 'listeners'}${updatedAt ? ` · updated ${new Date(updatedAt).toLocaleTimeString([], { hour12: false })} · refreshes every ${REFRESH_MS / 1000} s` : ''}`
        }
        actions={
          <>
            <Segmented<'tcp' | 'all'>
              size="sm"
              value={udp}
              onChange={setUdp}
              options={[
                { value: 'tcp', label: 'TCP' },
                { value: 'all', label: 'TCP + UDP' },
              ]}
            />
            <Button size="sm" icon={RefreshCw} loading={refreshing} onClick={() => void refresh(true)}>
              Refresh
            </Button>
          </>
        }
      >
        <div className="port-doctor__toolbar" ref={filterRef}>
          <TextInput
            className="port-doctor__filter"
            value={filter}
            onChange={setFilter}
            placeholder="Filter by port, process name or PID   (Ctrl+F)"
            aria-label="Filter listeners"
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter) {
                e.stopPropagation()
                setFilter('')
              }
            }}
            suffix={
              filter ? (
                <button type="button" className="port-doctor__clear" onClick={() => setFilter('')} aria-label="Clear filter" title="Clear filter">
                  <X size={13} />
                </button>
              ) : (
                <Search size={14} />
              )
            }
          />
        </div>

        <div className="port-doctor__chips">
          <span className="port-doctor__chipslabel">Dev ports in use</span>
          {rows == null ? (
            <span className="port-doctor__muted">…</span>
          ) : chips.length === 0 ? (
            <span className="port-doctor__muted">none — 3000, 5173, 8080, 25565 and the other usual ones are all free</span>
          ) : (
            chips.map((c) => {
              const on = filter.trim() === ':' + c.port
              return (
                <button key={c.port} type="button" className={cx('port-doctor__chip', on && 'is-on')} aria-pressed={on} onClick={() => setFilter(on ? '' : ':' + c.port)} title={`${processLabel(c.row)} — click to filter`}>
                  <span className="port-doctor__chipport">{c.port}</span>
                  <span className="port-doctor__chipname">{c.label ?? (c.row.name.replace(/\.exe$/i, '') || 'unknown')}</span>
                </button>
              )
            })
          )}
        </div>

        {error && (
          <div className="port-doctor__error">
            <Notice tone="error" icon={TriangleAlert} title="Could not read the port table">
              {error}
            </Notice>
          </div>
        )}

        <div className="port-doctor__table" role="table" aria-label="Listening ports" aria-rowcount={visible.length}>
          <div className="port-doctor__head" role="row">
            <button type="button" role="columnheader" className={cx('port-doctor__sort', sort === 'port' && 'is-on')} onClick={() => setSort('port')} title="Sort by port">
              Port {sort === 'port' && <ArrowDown size={11} />}
            </button>
            <span role="columnheader">Address</span>
            <span role="columnheader">Protocol</span>
            <button type="button" role="columnheader" className={cx('port-doctor__sort', sort === 'name' && 'is-on')} onClick={() => setSort('name')} title="Sort by process name">
              Process {sort === 'name' && <ArrowDown size={11} />}
            </button>
            <span role="columnheader" className="port-doctor__actionshead">
              Actions
            </span>
          </div>

          <div className="port-doctor__body" role="rowgroup">
            {rows == null && !error && (
              <div className="port-doctor__loading">
                <Spinner size={18} />
                <span>Reading the port table…</span>
              </div>
            )}

            {rows != null && visible.length === 0 && (
              <Empty icon={filter.trim() ? Search : Plug} title={filter.trim() ? `Nothing is listening that matches “${filter.trim()}”` : 'Nothing is listening'}>
                {filter.trim() ? (
                  <>
                    {filterIsPort ? 'That port looks free. A test bind makes sure.' : 'Try a port number, part of a process name (node, java …) or a PID.'}
                    <div className="port-doctor__emptyactions">
                      {filterIsPort && (
                        <Button
                          size="sm"
                          icon={Plug}
                          onClick={() => {
                            const p = filter.trim().replace(':', '')
                            setCheckText(p)
                            void runCheck(p)
                          }}
                        >
                          Check port {filter.trim().replace(':', '')}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" icon={X} onClick={() => setFilter('')}>
                        Clear filter
                      </Button>
                    </div>
                  </>
                ) : (
                  'No program on this PC has a port open right now. Start your dev server and it shows up here within a few seconds.'
                )}
              </Empty>
            )}

            {visible.map((row) => {
              const open = openKey === row.key
              const asking = confirm?.key === row.key ? confirm.step : 0
              const busy = killing === row.key
              const locked = row.protection === 'system' || row.protection === 'self'
              return (
                <div key={row.key} className={cx('port-doctor__item', open && 'is-open', asking > 0 && 'is-asking')}>
                  <div
                    className="port-doctor__row"
                    role="row"
                    tabIndex={0}
                    aria-expanded={open}
                    data-port={row.port}
                    onClick={(e) => {
                      if (!(e.target as HTMLElement).closest('button')) toggleOpen(row)
                    }}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggleOpen(row)
                      } else if (e.key === 'ArrowDown') moveFocus(e, 1)
                      else if (e.key === 'ArrowUp') moveFocus(e, -1)
                    }}
                  >
                    <span role="cell" className="port-doctor__port">
                      {row.port}
                    </span>
                    <span role="cell" className="port-doctor__addr">
                      <span className="port-doctor__addrtext" title={row.addresses.join('\n')}>
                        {row.addresses.join(' · ')}
                      </span>
                      {row.scope === 'lan' ? (
                        <span title="Bound to a network address: other devices on your network can reach it (if the firewall lets them).">
                          <Badge tone="info">LAN</Badge>
                        </span>
                      ) : (
                        <span title="Bound to localhost: only programs on this PC can reach it.">
                          <Badge>local</Badge>
                        </span>
                      )}
                    </span>
                    <span role="cell" className="port-doctor__proto">
                      {row.proto}
                    </span>
                    <span role="cell" className="port-doctor__proc">
                      <span className="port-doctor__procname" title={row.name}>
                        {row.name || 'unknown'}
                      </span>
                      <span className="port-doctor__pid">PID {row.pid}</span>
                      {row.protection === 'system' && <Badge tone="warn">system</Badge>}
                      {row.protection === 'self' && <Badge tone="accent">this app</Badge>}
                    </span>
                    <span role="cell" className="port-doctor__actions">
                      <Button size="sm" variant="ghost" icon={ChevronDown} className={cx('port-doctor__detailsbtn', open && 'is-open')} onClick={() => toggleOpen(row)} aria-expanded={open}>
                        Details
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        icon={Skull}
                        disabled={locked || busy || asking > 0}
                        title={locked ? row.protectionReason : `End ${processLabel(row)}`}
                        aria-label={`End process ${processLabel(row)}`}
                        onClick={() => setConfirm({ key: row.key, step: 1 })}
                      >
                        <span className="port-doctor__wide">End process</span>
                        <span className="port-doctor__narrow">End</span>
                      </Button>
                    </span>
                  </div>

                  {asking > 0 && (
                    <div className="port-doctor__confirm" role="alertdialog" aria-label={`End ${processLabel(row)}?`}>
                      <TriangleAlert size={16} className="port-doctor__confirmicon" />
                      <div className="port-doctor__confirmtext">
                        {row.protection === 'confirm' && asking === 1 ? (
                          <>
                            <strong>{row.name} is part of Windows.</strong> {row.protectionReason}
                          </>
                        ) : row.protection === 'confirm' ? (
                          <>
                            <strong>Really end {processLabel(row)}?</strong> The Windows services inside it stop right now. Only do this if you know which ones they are.
                          </>
                        ) : (
                          <>
                            <strong>End {processLabel(row)}?</strong> It and everything it started is closed at once; unsaved work in it is lost.
                          </>
                        )}
                      </div>
                      <div className="port-doctor__confirmbtns">
                        <Button size="sm" autoFocus onClick={() => setConfirm(null)} disabled={busy}>
                          Cancel
                        </Button>
                        {row.protection === 'confirm' && asking === 1 ? (
                          <Button size="sm" variant="danger" onClick={() => setConfirm({ key: row.key, step: 2 })}>
                            I understand, continue
                          </Button>
                        ) : (
                          <Button size="sm" variant="danger" icon={Skull} loading={busy} onClick={() => void endProcess(row, row.protection === 'confirm')}>
                            {row.protection === 'confirm' ? 'Yes, end it anyway' : 'End process'}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}

                  {open && <DetailsView row={row} state={details[row.pid]} onRetry={() => void loadDetails(row.pid)} />}
                </div>
              )
            })}
          </div>
        </div>
      </Panel>
    </div>
  )
}

function DetailsView({ row, state, onRetry }: { row: PortRow; state: DetailState | undefined; onRetry: () => void }) {
  const toast = useToast()
  if (!state || state.status === 'loading') {
    return (
      <div className="port-doctor__details port-doctor__details--loading">
        <Spinner size={15} />
        <span>Asking Windows about PID {row.pid}…</span>
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="port-doctor__details">
        <Notice tone="warn" icon={TriangleAlert} title="No details available">
          {state.message}
        </Notice>
        <div className="port-doctor__detailactions">
          <Button size="sm" icon={RefreshCw} onClick={onRetry}>
            Try again
          </Button>
        </div>
      </div>
    )
  }
  const d = state.data
  const hidden = <span className="port-doctor__muted">Hidden by Windows for this process — start Utility as administrator to see it.</span>
  return (
    <div className="port-doctor__details">
      {(row.protection === 'system' || row.protection === 'self') && (
        <Notice tone="info" icon={ShieldAlert} title="Cannot be ended from here">
          {row.protectionReason}
        </Notice>
      )}
      <dl className="port-doctor__facts">
        <div className="port-doctor__fact port-doctor__fact--full">
          <dt>Program</dt>
          <dd className="port-doctor__mono">{d.path ?? hidden}</dd>
        </div>
        <div className="port-doctor__fact port-doctor__fact--full">
          <dt>Command line</dt>
          <dd className="port-doctor__mono">{d.commandLine ?? hidden}</dd>
        </div>
        <div className="port-doctor__fact">
          <dt>Started</dt>
          <dd>{d.started ? `${new Date(d.started).toLocaleString([], { hour12: false })} · ${since(d.started)}` : '—'}</dd>
        </div>
        <div className="port-doctor__fact">
          <dt>Started by</dt>
          <dd>{d.parentName ? `${d.parentName} (PID ${d.parentPid})` : d.parentPid ? `PID ${d.parentPid} (no longer running)` : '—'}</dd>
        </div>
        <div className="port-doctor__fact">
          <dt>Memory</dt>
          <dd>
            {formatBytes(d.memory)} · {d.threads} threads
          </dd>
        </div>
        <div className="port-doctor__fact">
          <dt>User</dt>
          <dd>{d.owner ?? '—'}</dd>
        </div>
      </dl>
      <div className="port-doctor__detailactions">
        {d.commandLine && <CopyButton text={d.commandLine} label="Copy command line" />}
        {d.path && <CopyButton text={d.path} label="Copy path" />}
        {d.path && (
          <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => core.reveal(d.path!).catch((err) => toast.error('Could not open the folder', { detail: errorMessage(err) }))}>
            Show in Explorer
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={onRetry}>
          Reload
        </Button>
      </div>
    </div>
  )
}
