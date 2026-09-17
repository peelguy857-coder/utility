import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, ExternalLink, File as FileIcon, FolderOpen, MessageSquareText, MonitorSmartphone, Power, ScanLine, SendHorizontal, ShieldCheck, Smartphone, Upload, Wifi, X } from 'lucide-react'
import { core, errorMessage, useBackend, useBackendEvent } from '@/lib/bridge'
import { cx, formatBytes } from '@/lib/format'
import { drawQr, qrMatrix } from '@/lib/qr'
import { useToast } from '@/components/Toasts'
import { Dropzone } from '@/components/Dropzone'
import { LanAdvisor } from '@/components/LanAdvisor'
import { Button, CopyButton, Empty, IconButton, Notice, Panel, Progress, Select, Stack, TextArea, Workbench } from '@/components/ui'
import './ui.css'

interface SharedFile {
  id: string
  name: string
  size: number
  path: string
}
interface TextEntry {
  id: string
  text: string
  from: 'pc' | 'phone'
  time: number
}
interface Received {
  id: string
  name: string
  path: string
  size: number
  time: number
}
interface DropState {
  running: boolean
  port: number
  urls: string[]
  addresses: Array<{ name: string; address: string }>
  phones: number
  shared: SharedFile[]
  texts: TextEntry[]
  received: Received[]
  pcName: string
  receiveDir: string
}
interface UploadProgress {
  id: string
  name: string
  received: number
  total: number
  done?: boolean
  failed?: boolean
}

const isLink = (text: string) => /^https?:\/\/\S+$/i.test(text.trim())

function QrPanel({ url }: { url: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (ref.current) drawQr(ref.current, qrMatrix(url, 'M'), 640, { margin: 3, fg: '#0d0e12', bg: '#ffffff', rounded: false })
  }, [url])
  return <canvas ref={ref} className="phonedrop__qr" aria-label="QR code with the link for your phone" />
}

export default function PhoneDrop() {
  const api = useBackend('phone-drop')
  const toast = useToast()
  const [state, setState] = useState<DropState | null>(null)
  const [busy, setBusy] = useState(false)
  const [urlIndex, setUrlIndex] = useState(0)
  const [text, setText] = useState('')
  const [uploads, setUploads] = useState<Record<string, UploadProgress>>({})

  useEffect(() => {
    api.invoke<DropState>('state').then(setState).catch(() => {})
  }, [api])

  useBackendEvent<DropState>('phone-drop', 'state', setState)
  useBackendEvent<UploadProgress>('phone-drop', 'upload-progress', (p) =>
    setUploads((map) => {
      const next = { ...map }
      if (p.done || p.failed) delete next[p.id]
      else next[p.id] = p
      return next
    }),
  )
  useBackendEvent<Received>('phone-drop', 'received', (entry) =>
    toast.ok(`Received ${entry.name}`, { detail: formatBytes(entry.size), action: { label: 'Show', run: () => api.invoke('reveal', { id: entry.id }).catch(() => {}) } }),
  )
  useBackendEvent<TextEntry>('phone-drop', 'text', (entry) =>
    toast.info('Text from your phone', { detail: entry.text.slice(0, 120), action: { label: 'Copy', run: () => core.copyText(entry.text) } }),
  )

  const run = useCallback(
    async (method: string, args?: unknown) => {
      try {
        const next = await api.invoke<DropState | { state: DropState; problems: string[] } | undefined>(method, args)
        if (next && 'problems' in next) {
          setState(next.state)
          if (next.problems.length) toast.warn('Some items were skipped', { detail: next.problems.join('\n') })
        } else if (next && 'running' in next) setState(next)
      } catch (err) {
        toast.error('That did not work', { detail: errorMessage(err) })
      }
    },
    [api, toast],
  )

  const toggle = async () => {
    setBusy(true)
    await run(state?.running ? 'stop' : 'start')
    setBusy(false)
  }

  const url = state?.urls[Math.min(urlIndex, (state?.urls.length ?? 1) - 1)] ?? ''
  const incoming = useMemo(() => {
    if (!state) return []
    const files = state.received.map((r) => ({ kind: 'file' as const, time: r.time, file: r }))
    const texts = state.texts.filter((t) => t.from === 'phone').map((t) => ({ kind: 'text' as const, time: t.time, text: t }))
    return [...files, ...texts].sort((a, b) => b.time - a.time)
  }, [state])
  const outgoingTexts = state?.texts.filter((t) => t.from === 'pc') ?? []

  if (!state) return null

  if (!state.running) {
    return (
      <Stack gap={16}>
        <LanAdvisor />
        <Panel>
          <div className="phonedrop__hero">
            <div className="phonedrop__hero-art">
              <MonitorSmartphone size={44} strokeWidth={1.5} />
            </div>
            <h2>Like AirDrop, but for a Windows PC</h2>
            <p>Start sharing, scan the code with your phone’s camera, and a page opens where you can send photos, files and text here — and pick up whatever you drop in from this side.</p>
            <Button variant="primary" size="lg" icon={Power} loading={busy} onClick={toggle}>
              Start sharing
            </Button>
          </div>
        </Panel>
        <div className="phonedrop__facts">
          <div>
            <Wifi size={16} />
            <span>
              <strong>Same Wi-Fi only.</strong> Nothing goes through the internet; the phone talks straight to this PC.
            </span>
          </div>
          <div>
            <ShieldCheck size={16} />
            <span>
              <strong>Secret link.</strong> A new random link every time you start. It stops working the moment you press Stop or close the app.
            </span>
          </div>
          <div>
            <ScanLine size={16} />
            <span>
              <strong>First time:</strong> Windows asks whether to allow network access. Choose <em>Private networks</em>, otherwise the phone cannot reach the PC.
            </span>
          </div>
        </div>
      </Stack>
    )
  }

  return (
    <Workbench
      sideWidth={330}
      side={
        <>
          <Panel flush>
            <div className="phonedrop__scan">
              {url ? <QrPanel url={url} /> : <Notice tone="warn" title="No network found">Connect this PC to Wi-Fi or Ethernet first.</Notice>}
              <div className={cx('phonedrop__phones', state.phones > 0 && 'is-on')}>
                <span className="phonedrop__dot" />
                {state.phones === 0 ? 'Waiting for your phone — scan with the camera' : state.phones === 1 ? 'Phone connected' : `${state.phones} phones connected`}
              </div>
            </div>
            <div className="phonedrop__link">
              <code title={url}>{url.replace(/^http:\/\//, '')}</code>
              <CopyButton text={url} label="Copy link" />
            </div>
          </Panel>

          {state.urls.length > 1 && (
            <Panel title="Network" hint="Phone cannot connect? It may be on a different network than the one selected.">
              <Select
                value={String(Math.min(urlIndex, state.urls.length - 1))}
                onChange={(v) => setUrlIndex(Number(v))}
                options={state.addresses.map((a, i) => ({ value: String(i), label: `${a.address}  ·  ${a.name}` }))}
              />
            </Panel>
          )}

          <Panel title="Saving to">
            <div className="phonedrop__folder" title={state.receiveDir}>
              {state.receiveDir}
            </div>
            <div className="phonedrop__folder-actions">
              <Button size="sm" icon={FolderOpen} onClick={() => run('openFolder')}>
                Open
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  const folder = await core.pickFolder({ title: 'Where should files from the phone go?' })
                  if (folder) run('chooseFolder', { folder })
                }}
              >
                Change…
              </Button>
            </div>
          </Panel>

          <Button variant="danger" icon={Power} block loading={busy} onClick={toggle}>
            Stop sharing
          </Button>
        </>
      }
    >
      {state.phones === 0 && <LanAdvisor />}
      <Panel title="Send to your phone" hint="Anything here shows up on the phone’s page instantly.">
        <Stack gap={12}>
          <Dropzone compact multiple title="Drop files here" hint="or browse — they stay where they are, the phone downloads a copy" icon={Upload} onPaths={(paths) => run('share', { paths })} />
          {state.shared.length > 0 && (
            <ul className="phonedrop__list">
              {state.shared.map((file) => (
                <li key={file.id}>
                  <span className="phonedrop__badge">
                    <FileIcon size={15} />
                  </span>
                  <span className="phonedrop__grow">
                    <span className="phonedrop__name">{file.name}</span>
                    <span className="phonedrop__meta">{formatBytes(file.size)}</span>
                  </span>
                  <IconButton icon={X} label="Stop sharing this file" onClick={() => run('unshare', { id: file.id })} />
                </li>
              ))}
            </ul>
          )}
          <div className="phonedrop__compose">
            <TextArea value={text} onChange={setText} rows={2} mono={false} placeholder="Or send a link / some text…" />
            <Button
              variant="primary"
              icon={SendHorizontal}
              disabled={!text.trim()}
              onClick={async () => {
                await run('sendText', { text })
                setText('')
              }}
            >
              Send
            </Button>
          </div>
          {outgoingTexts.length > 0 && (
            <ul className="phonedrop__list">
              {outgoingTexts
                .slice()
                .reverse()
                .map((t) => (
                  <li key={t.id}>
                    <span className="phonedrop__badge">
                      <MessageSquareText size={15} />
                    </span>
                    <span className="phonedrop__grow">
                      <span className="phonedrop__text">{t.text}</span>
                    </span>
                    <IconButton icon={X} label="Remove from the phone’s page" onClick={() => run('removeText', { id: t.id })} />
                  </li>
                ))}
            </ul>
          )}
        </Stack>
      </Panel>

      <Panel title="From your phone">
        {Object.keys(uploads).length === 0 && incoming.length === 0 ? (
          <Empty icon={Smartphone} title="Nothing yet">
            Scan the code, then choose photos or files on the phone. They appear here as they arrive.
          </Empty>
        ) : (
          <ul className="phonedrop__list">
            {Object.values(uploads).map((u) => (
              <li key={u.id} className="is-uploading">
                <span className="phonedrop__grow">
                  <Progress value={u.total ? u.received / u.total : null} label={u.name} detail={u.total ? `${formatBytes(u.received)} of ${formatBytes(u.total)}` : formatBytes(u.received)} />
                </span>
              </li>
            ))}
            {incoming.map((item) =>
              item.kind === 'file' ? (
                <li key={item.file.id}>
                  <span className="phonedrop__badge">
                    <FileIcon size={15} />
                  </span>
                  <span className="phonedrop__grow">
                    <span className="phonedrop__name">{item.file.name}</span>
                    <span className="phonedrop__meta">
                      {formatBytes(item.file.size)} · {new Date(item.file.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => run('open', { id: item.file.id })}>
                    Open
                  </Button>
                  <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => run('reveal', { id: item.file.id })}>
                    Show
                  </Button>
                </li>
              ) : (
                <li key={item.text.id}>
                  <span className="phonedrop__badge">
                    <MessageSquareText size={15} />
                  </span>
                  <span className="phonedrop__grow">
                    <span className="phonedrop__text">{item.text.text}</span>
                  </span>
                  {isLink(item.text.text) && (
                    <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => core.openExternal(item.text.text.trim())}>
                      Open
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Copy}
                    onClick={async () => {
                      await core.copyText(item.text.text)
                      toast.ok('Copied')
                    }}
                  >
                    Copy
                  </Button>
                </li>
              ),
            )}
          </ul>
        )}
      </Panel>
    </Workbench>
  )
}
