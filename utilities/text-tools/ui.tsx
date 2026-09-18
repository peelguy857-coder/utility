import { useEffect, useMemo, useState } from 'react'
import { ArrowDownUp, ClipboardPaste, Eraser, RefreshCw } from 'lucide-react'
import { core } from '@/lib/bridge'
import { cx } from '@/lib/format'
import { Button, CopyButton, Field, NumberInput, Panel, Row, Segmented, Select, Stack, TextArea, TextInput, Toggle } from '@/components/ui'
import './ui.css'

type Tab = 'json' | 'base64' | 'url' | 'generate' | 'time' | 'case' | 'hash'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'json', label: 'JSON' },
  { id: 'base64', label: 'Base64' },
  { id: 'url', label: 'URL' },
  { id: 'generate', label: 'Generate' },
  { id: 'time', label: 'Time' },
  { id: 'case', label: 'Case & count' },
  { id: 'hash', label: 'Hash' },
]

const utf8 = new TextEncoder()
const bytesOf = (s: string) => utf8.encode(s).length

function positionOf(text: string, message: string): string {
  const m = /position (\d+)/.exec(message)
  if (!m) return message
  const at = Number(m[1])
  const before = text.slice(0, at)
  const line = before.split('\n').length
  const col = at - before.lastIndexOf('\n')
  return `${message.replace(/ in JSON at position \d+.*$/, '')} — line ${line}, column ${col}`
}

const sortKeys = (v: unknown): unknown => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v)

function b64encode(s: string, urlSafe: boolean): string {
  const out = btoa(String.fromCharCode(...utf8.encode(s)))
  return urlSafe ? out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : out
}
function b64decode(s: string): string {
  const norm = s.trim().replace(/-/g, '+').replace(/_/g, '/')
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4)
  const bin = atob(padded)
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-./]+/g, ' ').trim().split(/\s+/).filter(Boolean)
const CASES: Record<string, (s: string) => string> = {
  camelCase: (s) => words(s).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(''),
  PascalCase: (s) => words(s).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(''),
  snake_case: (s) => words(s).map((w) => w.toLowerCase()).join('_'),
  'kebab-case': (s) => words(s).map((w) => w.toLowerCase()).join('-'),
  CONSTANT_CASE: (s) => words(s).map((w) => w.toUpperCase()).join('_'),
  'Title Case': (s) => words(s).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' '),
  'Sentence case': (s) => { const t = s.trim().toLowerCase(); return t ? t[0].toUpperCase() + t.slice(1) : t },
  lowercase: (s) => s.toLowerCase(),
  UPPERCASE: (s) => s.toUpperCase(),
}

async function digest(algo: string, text: string): Promise<string> {
  const buf = await crypto.subtle.digest(algo, utf8.encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function Pane({ label, value, onChange, readOnly, rows = 12, extra }: { label: string; value: string; onChange?: (v: string) => void; readOnly?: boolean; rows?: number; extra?: React.ReactNode }) {
  return (
    <Panel
      title={label}
      actions={
        <Row gap={4}>
          {extra}
          {!readOnly && onChange && (
            <Button size="sm" variant="ghost" icon={ClipboardPaste} onClick={async () => onChange(await core.readClipboard())}>
              Paste
            </Button>
          )}
          {!readOnly && onChange && (
            <Button size="sm" variant="ghost" icon={Eraser} onClick={() => onChange('')}>
              Clear
            </Button>
          )}
          <CopyButton text={value} />
        </Row>
      }
    >
      <TextArea value={value} onChange={onChange} readOnly={readOnly} rows={rows} />
    </Panel>
  )
}

export default function TextTools() {
  const [tab, setTab] = useState<Tab>('json')
  useEffect(() => {
    core.getUtilSettings<{ tab: Tab }>('text-tools').then((s) => s.tab && TABS.some((t) => t.id === s.tab) && setTab(s.tab))
  }, [])
  const pickTab = (t: Tab) => {
    setTab(t)
    core.setUtilSettings('text-tools', { tab: t })
  }

  return (
    <Stack gap={16}>
      <Segmented<Tab> value={tab} onChange={pickTab} options={TABS.map((t) => ({ value: t.id, label: t.label }))} />
      {tab === 'json' && <JsonTool />}
      {tab === 'base64' && <Base64Tool />}
      {tab === 'url' && <UrlTool />}
      {tab === 'generate' && <GenerateTool />}
      {tab === 'time' && <TimeTool />}
      {tab === 'case' && <CaseTool />}
      {tab === 'hash' && <HashTool />}
    </Stack>
  )
}

function JsonTool() {
  const [input, setInput] = useState('{"name":"Utility","tools":["dmg","mirror"],"version":1}')
  const [indent, setIndent] = useState<'2' | '4' | 'tab' | 'min'>('2')
  const [sorted, setSorted] = useState(false)
  const result = useMemo(() => {
    if (!input.trim()) return { out: '', error: '' }
    try {
      let v = JSON.parse(input)
      if (sorted) v = sortKeys(v)
      return { out: indent === 'min' ? JSON.stringify(v) : JSON.stringify(v, null, indent === 'tab' ? '\t' : Number(indent)), error: '' }
    } catch (err) {
      return { out: '', error: positionOf(input, (err as Error).message) }
    }
  }, [input, indent, sorted])
  return (
    <div className="tt__two">
      <Pane label="JSON in" value={input} onChange={setInput} />
      <Pane
        label={result.error ? 'Not valid' : 'Formatted'}
        value={result.error || result.out}
        readOnly
        extra={
          <>
            <Segmented<'2' | '4' | 'tab' | 'min'> size="sm" value={indent} onChange={setIndent} options={[{ value: '2', label: '2' }, { value: '4', label: '4' }, { value: 'tab', label: 'Tab' }, { value: 'min', label: 'Minify' }]} />
            <Field label="Sort keys" inline>
              <Toggle checked={sorted} onChange={setSorted} />
            </Field>
          </>
        }
      />
    </div>
  )
}

function Base64Tool() {
  const [text, setText] = useState('Hello from Utility')
  const [urlSafe, setUrlSafe] = useState(false)
  const [dir, setDir] = useState<'encode' | 'decode'>('encode')
  const out = useMemo(() => {
    try {
      return dir === 'encode' ? b64encode(text, urlSafe) : b64decode(text)
    } catch {
      return 'That is not valid Base64.'
    }
  }, [text, urlSafe, dir])
  return (
    <div className="tt__two">
      <Pane label={dir === 'encode' ? 'Text' : 'Base64'} value={text} onChange={setText} />
      <Pane
        label={dir === 'encode' ? 'Base64' : 'Text'}
        value={out}
        readOnly
        extra={
          <>
            <Button size="sm" variant="ghost" icon={ArrowDownUp} onClick={() => { setDir(dir === 'encode' ? 'decode' : 'encode'); setText(out) }}>
              {dir === 'encode' ? 'Decode instead' : 'Encode instead'}
            </Button>
            <Field label="URL-safe" inline>
              <Toggle checked={urlSafe} onChange={setUrlSafe} />
            </Field>
          </>
        }
      />
    </div>
  )
}

function UrlTool() {
  const [url, setUrl] = useState('https://example.com/search?q=hello world&page=2#top')
  const parsed = useMemo(() => {
    try {
      return new URL(url)
    } catch {
      return null
    }
  }, [url])
  const params = parsed ? [...parsed.searchParams.entries()] : []
  const setParam = (i: number, key: string, value: string) => {
    if (!parsed) return
    const next = new URL(parsed.toString())
    next.search = ''
    params.forEach(([k, v], j) => (j === i ? key && next.searchParams.append(key, value) : next.searchParams.append(k, v)))
    setUrl(next.toString())
  }
  return (
    <Stack gap={16}>
      <Panel title="URL" actions={<CopyButton text={url} />}>
        <TextInput value={url} onChange={setUrl} mono />
        {!parsed && url.trim() && <p className="tt__err">Not a complete URL (it needs https:// at the front).</p>}
      </Panel>
      {parsed && (
        <div className="tt__two">
          <Panel title="Parts">
            <div className="tt__parts">
              {[['Protocol', parsed.protocol], ['Host', parsed.host], ['Path', parsed.pathname], ['Hash', parsed.hash]].map(([k, v]) => (
                <div key={k}>
                  <span>{k}</span>
                  <code>{v || '—'}</code>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Query" hint="Edit the values; the URL above updates." actions={<Button size="sm" variant="ghost" onClick={() => { const n = new URL(parsed.toString()); n.searchParams.append('key', 'value'); setUrl(n.toString()) }}>Add</Button>}>
            <div className="tt__params">
              {params.map(([k, v], i) => (
                <div key={i} className="tt__param">
                  <TextInput value={k} onChange={(nk) => setParam(i, nk, v)} mono />
                  <TextInput value={v} onChange={(nv) => setParam(i, k, nv)} mono />
                  <Button size="sm" variant="ghost" onClick={() => setParam(i, '', '')}>Remove</Button>
                </div>
              ))}
              {params.length === 0 && <p className="tt__muted">No query parameters.</p>}
            </div>
          </Panel>
        </div>
      )}
      <div className="tt__two">
        <Pane label="Encode a piece of text for a URL" value={encodeURIComponent(url)} readOnly rows={3} />
        <Pane label="Decoded" value={(() => { try { return decodeURIComponent(url) } catch { return 'Cannot decode' } })()} readOnly rows={3} />
      </div>
    </Stack>
  )
}

function randomPassword(length: number, sets: { lower: boolean; upper: boolean; digits: boolean; symbols: boolean; noAmbiguous: boolean }): string {
  let chars = ''
  if (sets.lower) chars += 'abcdefghijkmnopqrstuvwxyz' + (sets.noAmbiguous ? '' : 'l')
  if (sets.upper) chars += 'ABCDEFGHJKLMNPQRSTUVWXYZ' + (sets.noAmbiguous ? '' : 'IO')
  if (sets.digits) chars += '23456789' + (sets.noAmbiguous ? '' : '01')
  if (sets.symbols) chars += '!@#$%^&*()-_=+[]{};:,.?'
  if (!chars) return ''
  const out: string[] = []
  const buf = new Uint32Array(length * 2)
  crypto.getRandomValues(buf)
  const limit = Math.floor(0x100000000 / chars.length) * chars.length // rejection sampling: no bias
  for (let i = 0; out.length < length; i++) {
    if (i >= buf.length) {
      crypto.getRandomValues(buf)
      i = 0
    }
    if (buf[i] < limit) out.push(chars[buf[i] % chars.length])
  }
  return out.join('')
}

function GenerateTool() {
  const [count, setCount] = useState(5)
  const [uuids, setUuids] = useState<string[]>(() => Array.from({ length: 5 }, () => crypto.randomUUID()))
  const [length, setLength] = useState(20)
  const [sets, setSets] = useState({ lower: true, upper: true, digits: true, symbols: true, noAmbiguous: true })
  const [pw, setPw] = useState(() => randomPassword(20, { lower: true, upper: true, digits: true, symbols: true, noAmbiguous: true }))
  const [hexLen, setHexLen] = useState(32)
  const hex = useMemo(() => [...crypto.getRandomValues(new Uint8Array(hexLen))].map((b) => b.toString(16).padStart(2, '0')).join(''), [hexLen])
  return (
    <div className="tt__two">
      <Panel title="UUIDs" actions={<Row gap={6}><NumberInput value={count} onChange={setCount} min={1} max={100} width={80} /><Button size="sm" icon={RefreshCw} onClick={() => setUuids(Array.from({ length: count }, () => crypto.randomUUID()))}>New</Button><CopyButton text={uuids.join('\n')} /></Row>}>
        <TextArea value={uuids.join('\n')} readOnly rows={Math.min(12, Math.max(3, uuids.length))} />
      </Panel>
      <Stack gap={16}>
        <Panel title="Password" actions={<Row gap={6}><Button size="sm" icon={RefreshCw} onClick={() => setPw(randomPassword(length, sets))}>New</Button><CopyButton text={pw} /></Row>}>
          <Stack gap={10}>
            <code className="tt__big">{pw}</code>
            <Field label="Length" inline>
              <NumberInput value={length} onChange={(v) => { setLength(v); setPw(randomPassword(v, sets)) }} min={4} max={128} width={90} />
            </Field>
            <div className="tt__toggles">
              {(['lower', 'upper', 'digits', 'symbols', 'noAmbiguous'] as const).map((k) => (
                <Field key={k} label={{ lower: 'a–z', upper: 'A–Z', digits: '0–9', symbols: '!@#…', noAmbiguous: 'No l / 1 / O / 0' }[k]} inline>
                  <Toggle checked={sets[k]} onChange={(on) => { const n = { ...sets, [k]: on }; setSets(n); setPw(randomPassword(length, n)) }} />
                </Field>
              ))}
            </div>
          </Stack>
        </Panel>
        <Panel title="Random hex" actions={<Row gap={6}><NumberInput value={hexLen} onChange={setHexLen} min={1} max={256} suffix="bytes" width={120} /><CopyButton text={hex} /></Row>}>
          <code className="tt__wrap">{hex}</code>
        </Panel>
      </Stack>
    </div>
  )
}

function TimeTool() {
  const [input, setInput] = useState(String(Math.floor(Date.now() / 1000)))
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const date = useMemo(() => {
    const t = input.trim()
    if (!t) return null
    if (/^\d{11,14}$/.test(t)) return new Date(Number(t))
    if (/^\d{1,10}$/.test(t)) return new Date(Number(t) * 1000)
    const d = new Date(t)
    return isNaN(d.getTime()) ? null : d
  }, [input])
  const rel = (d: Date) => {
    const s = Math.round((d.getTime() - now) / 1000)
    const abs = Math.abs(s)
    const unit = abs < 60 ? [abs, 'second'] : abs < 3600 ? [Math.round(abs / 60), 'minute'] : abs < 86400 ? [Math.round(abs / 3600), 'hour'] : [Math.round(abs / 86400), 'day']
    return `${unit[0]} ${unit[1]}${unit[0] === 1 ? '' : 's'} ${s < 0 ? 'ago' : 'from now'}`
  }
  const rows = date
    ? [
        ['Unix seconds', String(Math.floor(date.getTime() / 1000))],
        ['Unix milliseconds', String(date.getTime())],
        ['ISO 8601 (UTC)', date.toISOString()],
        ['Local', date.toLocaleString()],
        ['Date only', date.toISOString().slice(0, 10)],
        ['RFC 2822', date.toUTCString()],
        ['Relative', rel(date)],
      ]
    : []
  return (
    <div className="tt__two">
      <Panel title="Any time" hint="Unix seconds or milliseconds, ISO, or anything Date understands." actions={<Button size="sm" variant="ghost" onClick={() => setInput(String(Math.floor(Date.now() / 1000)))}>Now</Button>}>
        <TextInput value={input} onChange={setInput} mono />
        {!date && input.trim() && <p className="tt__err">Not a time I understand.</p>}
      </Panel>
      <Panel title="Is">
        <div className="tt__parts">
          {rows.map(([k, v]) => (
            <div key={k}>
              <span>{k}</span>
              <code>{v}</code>
              <CopyButton text={v} label="" />
            </div>
          ))}
          {!date && <p className="tt__muted">Right now: {Math.floor(now / 1000)} · {new Date(now).toISOString()}</p>}
        </div>
      </Panel>
    </div>
  )
}

function CaseTool() {
  const [text, setText] = useState('hello world from the utility app')
  const [mode, setMode] = useState('Title Case')
  const [ops, setOps] = useState({ trim: false, dedupe: false, sort: false })
  const out = useMemo(() => {
    let lines = text.split('\n')
    if (ops.trim) lines = lines.map((l) => l.trim()).filter(Boolean)
    if (ops.dedupe) lines = [...new Set(lines)]
    if (ops.sort) lines = [...lines].sort((a, b) => a.localeCompare(b))
    return lines.map((l) => CASES[mode](l)).join('\n')
  }, [text, mode, ops])
  const stats = `${text.length} chars · ${bytesOf(text)} bytes · ${text.trim() ? text.trim().split(/\s+/).length : 0} words · ${text ? text.split('\n').length : 0} lines`
  return (
    <div className="tt__two">
      <Pane label="Text" value={text} onChange={setText} extra={<span className="tt__stats">{stats}</span>} />
      <Pane
        label="Changed"
        value={out}
        readOnly
        extra={
          <>
            <Select value={mode} onChange={setMode} options={Object.keys(CASES).map((k) => ({ value: k, label: k }))} />
            {(['trim', 'dedupe', 'sort'] as const).map((k) => (
              <Button key={k} size="sm" variant={ops[k] ? 'secondary' : 'ghost'} onClick={() => setOps({ ...ops, [k]: !ops[k] })} className={cx(ops[k] && 'is-on')}>
                {k === 'trim' ? 'Trim lines' : k === 'dedupe' ? 'Unique lines' : 'Sort lines'}
              </Button>
            ))}
          </>
        }
      />
    </div>
  )
}

function HashTool() {
  const [text, setText] = useState('hello')
  const [hashes, setHashes] = useState<Array<[string, string]>>([])
  useEffect(() => {
    let live = true
    Promise.all(['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'].map(async (a) => [a, await digest(a, text)] as [string, string])).then((r) => live && setHashes(r))
    return () => {
      live = false
    }
  }, [text])
  return (
    <div className="tt__two">
      <Pane label="Text" value={text} onChange={setText} rows={8} />
      <Panel title="Hashes" hint="MD5 is not offered here (it is broken); File Hash does files.">
        <div className="tt__parts">
          {hashes.map(([k, v]) => (
            <div key={k}>
              <span>{k}</span>
              <code className="tt__wrap">{v}</code>
              <CopyButton text={v} label="" />
            </div>
          ))}
        </div>
      </Panel>
    </div>
  )
}
