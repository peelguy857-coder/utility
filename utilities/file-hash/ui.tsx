import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, ClipboardPaste, File as FileIcon, Fingerprint, Save, ShieldQuestion, X, XCircle } from 'lucide-react'
import { core, errorMessage, useBackend, useBackendEvent } from '@/lib/bridge'
import { baseName, cx, formatBytes, formatDuration } from '@/lib/format'
import { useToast } from '@/components/Toasts'
import { Dropzone } from '@/components/Dropzone'
import { Button, CopyButton, IconButton, Panel, Progress, Row, Segmented, Stack, TextArea } from '@/components/ui'
import './ui.css'

type Algo = 'md5' | 'sha1' | 'sha256' | 'sha512'
const ALGOS: Array<{ id: Algo; label: string }> = [
  { id: 'sha256', label: 'SHA-256' },
  { id: 'sha512', label: 'SHA-512' },
  { id: 'sha1', label: 'SHA-1' },
  { id: 'md5', label: 'MD5' },
]

interface Item {
  id: string
  path: string
  name: string
  size: number | null
  state: 'waiting' | 'hashing' | 'done' | 'failed'
  done: number
  total: number
  digests: Partial<Record<Algo, string | null>>
  ms?: number
  error?: string
}

interface Verdict {
  status: 'match' | 'mismatch' | 'no-files'
  files: Array<{ id: string; name: string; result: 'match' | 'mismatch' | 'unrelated'; algo: string | null; expected: string | null; actual: string | null }>
}
interface CompareReply {
  parsed: { ok: true; candidates: Array<{ hex: string; algo: string; fileName: string | null }> } | { ok: false; reason: string; message: string }
  verdict: Verdict | null
}

let counter = 0

export default function FileHash() {
  const api = useBackend('file-hash')
  const toast = useToast()
  const [items, setItems] = useState<Item[]>([])
  const [upper, setUpper] = useState(false)
  const [expected, setExpected] = useState('')
  const [compare, setCompare] = useState<CompareReply | null>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items

  const patch = useCallback((id: string, change: Partial<Item>) => setItems((list) => list.map((it) => (it.id === id ? { ...it, ...change } : it))), [])

  useBackendEvent<{ id: string; done: number; total: number }>('file-hash', 'progress', (p) => patch(p.id, { state: 'hashing', done: p.done, total: p.total }))

  const add = (paths: string[]) => {
    const fresh = paths
      .filter((p) => !itemsRef.current.some((it) => it.path === p))
      .map<Item>((p) => ({ id: `job-${Date.now().toString(36)}-${counter++}`, path: p, name: baseName(p), size: null, state: 'waiting', done: 0, total: 0, digests: {} }))
    if (!fresh.length) return
    setItems((list) => [...fresh, ...list])
    for (const item of fresh) {
      api
        .invoke<{ cancelled?: boolean; size: number; digests: Item['digests']; ms: number }>('hash', { id: item.id, path: item.path })
        .then((res) => {
          if (res.cancelled) return
          patch(item.id, { state: 'done', size: res.size, digests: res.digests, ms: res.ms })
        })
        .catch((err) => patch(item.id, { state: 'failed', error: errorMessage(err) }))
    }
  }

  const remove = (id: string) => {
    api.invoke('forget', { id }).catch(() => {})
    setItems((list) => list.filter((it) => it.id !== id))
  }

  // re-judge whenever the pasted text or the finished files change
  const finishedIds = items.filter((it) => it.state === 'done').map((it) => it.id).join(',')
  useEffect(() => {
    if (!expected.trim()) return setCompare(null)
    const timer = window.setTimeout(() => {
      api
        .invoke<CompareReply>('compare', { text: expected, ids: finishedIds ? finishedIds.split(',') : [] })
        .then(setCompare)
        .catch(() => setCompare(null))
    }, 150)
    return () => window.clearTimeout(timer)
  }, [expected, finishedIds, api])

  const shown = (hex: string | null | undefined) => (hex ? (upper ? hex.toUpperCase() : hex.toLowerCase()) : '')
  const verdictFor = (id: string) => compare?.verdict?.files.find((f) => f.id === id)

  const copyAll = async () => {
    const ids = items.filter((it) => it.state === 'done').map((it) => it.id)
    try {
      const res = await api.invoke<{ text: string; count: number }>('sums', { ids, algo: 'sha256', upper })
      await core.copyText(res.text)
      toast.ok(`Copied ${res.count} SHA-256 line${res.count === 1 ? '' : 's'}`, { detail: 'Same format as sha256sum prints.' })
    } catch (err) {
      toast.error('Could not copy', { detail: errorMessage(err) })
    }
  }

  const saveSidecar = async (item: Item, overwrite = false): Promise<void> => {
    try {
      const res = await api.invoke<{ exists: boolean; path: string }>('saveSidecar', { id: item.id, algo: 'sha256', upper, overwrite })
      if (res.exists) return toast.warn(`${baseName(res.path)} already exists`, { action: { label: 'Replace', run: () => void saveSidecar(item, true) } })
      toast.ok('Saved next to the file', { detail: res.path, action: { label: 'Show', run: () => core.reveal(res.path) } })
    } catch (err) {
      toast.error('Could not save', { detail: errorMessage(err) })
    }
  }

  const overall = compare?.verdict?.status
  const parseProblem = compare && !compare.parsed.ok ? compare.parsed.message : null

  return (
    <Stack gap={16}>
      <div className="filehash__top">
        <Dropzone multiple title="Drop files to fingerprint" hint="Any size. MD5, SHA-1, SHA-256 and SHA-512 are worked out in one pass, on this PC." icon={Fingerprint} onPaths={add} />

        <Panel title="Check a download" hint="Paste the checksum from the download page. Spaces, upper/lower case and whole sha256sum lines are fine.">
          <Stack gap={10}>
            <TextArea value={expected} onChange={setExpected} rows={3} placeholder="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" />
            <Row justify="space-between">
              <div className={cx('filehash__verdict', overall && `is-${overall}`, parseProblem && 'is-problem')}>
                {!expected.trim() ? (
                  <>
                    <ShieldQuestion size={16} /> Nothing pasted yet
                  </>
                ) : parseProblem ? (
                  <>
                    <XCircle size={16} /> {parseProblem}
                  </>
                ) : overall === 'match' ? (
                  <>
                    <CheckCircle2 size={16} /> Match — the file is exactly what was published
                  </>
                ) : overall === 'mismatch' ? (
                  <>
                    <XCircle size={16} /> No match — do not trust this file
                  </>
                ) : (
                  <>
                    <ShieldQuestion size={16} /> Looks like a checksum. Now drop the file.
                  </>
                )}
              </div>
              <Button size="sm" variant="ghost" icon={ClipboardPaste} onClick={async () => setExpected(await core.readClipboard())}>
                Paste
              </Button>
            </Row>
          </Stack>
        </Panel>
      </div>

      {items.length > 0 && (
        <Row justify="space-between">
          <Segmented<'lower' | 'upper'>
            size="sm"
            value={upper ? 'upper' : 'lower'}
            onChange={(v) => setUpper(v === 'upper')}
            options={[
              { value: 'lower', label: 'abc123' },
              { value: 'upper', label: 'ABC123' },
            ]}
          />
          <Row gap={6}>
            <Button size="sm" variant="ghost" onClick={copyAll} disabled={!finishedIds}>
              Copy all as sha256sum
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={X}
              onClick={() => {
                for (const it of items) api.invoke('forget', { id: it.id }).catch(() => {})
                setItems([])
              }}
            >
              Clear
            </Button>
          </Row>
        </Row>
      )}

      {items.map((item) => {
        const verdict = verdictFor(item.id)
        return (
          <Panel key={item.id} flush className={cx('filehash__card', verdict?.result === 'match' && 'is-match', verdict?.result === 'mismatch' && 'is-mismatch')}>
            <div className="filehash__head">
              <span className="filehash__icon">
                <FileIcon size={16} />
              </span>
              <div className="filehash__name">
                <strong title={item.path}>{item.name}</strong>
                <span>
                  {item.size != null ? formatBytes(item.size) : '…'}
                  {item.ms != null && ` · hashed in ${formatDuration(item.ms)}`}
                  {verdict?.result === 'match' && ` · matches the pasted ${verdict.algo?.toUpperCase()}`}
                  {verdict?.result === 'mismatch' && ` · differs from the pasted ${verdict.algo?.toUpperCase()}`}
                </span>
              </div>
              {item.state === 'done' && (
                <Button size="sm" variant="ghost" icon={Save} onClick={() => saveSidecar(item)}>
                  Save .sha256
                </Button>
              )}
              <IconButton icon={X} label={item.state === 'hashing' ? 'Cancel' : 'Remove'} onClick={() => remove(item.id)} />
            </div>
            {(item.state === 'waiting' || item.state === 'hashing') && (
              <div className="filehash__body">
                <Progress value={item.total ? item.done / item.total : null} label={item.state === 'waiting' ? 'Waiting for its turn' : 'Reading'} detail={item.total ? `${formatBytes(item.done)} of ${formatBytes(item.total)}` : undefined} />
              </div>
            )}
            {item.state === 'failed' && <div className="filehash__body filehash__error">{item.error}</div>}
            {item.state === 'done' && (
              <div className="filehash__digests">
                {ALGOS.map((algo) => (
                  <div key={algo.id} className={cx('filehash__row', verdict?.result === 'match' && verdict.algo === algo.id && 'is-hit')}>
                    <span className="filehash__algo">{algo.label}</span>
                    <code>{shown(item.digests[algo.id])}</code>
                    <CopyButton text={() => shown(item.digests[algo.id])} label="Copy" />
                  </div>
                ))}
              </div>
            )}
          </Panel>
        )
      })}
    </Stack>
  )
}
