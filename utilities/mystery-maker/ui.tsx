import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, AudioLines, Eye, FileText, Flag, FolderOutput, FolderTree, Image as ImageIcon, KeyRound, Lock, Plus, Puzzle, QrCode, Trash2, Wand2, X } from 'lucide-react'
import { core, errorMessage, useBackend } from '@/lib/bridge'
import { baseName, cx, formatBytes, formatCount } from '@/lib/format'
import { useToast } from '@/components/Toasts'
import { Dropzone, PathChip } from '@/components/Dropzone'
import { Badge, Button, Empty, Field, IconButton, Notice, NumberInput, Panel, Progress, Row, Segmented, Select, Stack, TextArea, TextInput, Toggle } from '@/components/ui'
import { autoDecode, decodeAll, encodeAll, LAYER_KINDS, stripZeroWidth, type Layer } from './lib/ciphers'
import { lsbEmbed, lsbExtract, pngAddText, pngReadText } from './lib/stego'
import { drawSpectrogram, textToWav, wavToSamples } from './lib/spectro'
import { buildTrail, exampleTrail, KINDS, makeStep, type Step, type StepKind, type Trail } from './lib/trail'
import './ui.css'

type Tab = 'build' | 'decode'

const ICONS: Record<StepKind, typeof FileText> = { note: FileText, cipher: KeyRound, image: ImageIcon, audio: AudioLines, zip: Lock, qr: QrCode, folder: FolderTree, final: Flag }

// lets the screenshot run prove the engines inside the built app
;(window as unknown as { __mysteryTest?: () => Promise<unknown> }).__mysteryTest = async () => {
  const out: Record<string, unknown> = {}
  const layers: Layer[] = [{ kind: 'vigenere', key: 'LANTERN' }, { kind: 'base64' }, { kind: 'reverse' }]
  const secret = 'the password is MIDNIGHT'
  out.cipher = decodeAll(encodeAll(secret, layers), layers) === secret
  out.zeroWidth = decodeAll(encodeAll(secret, [{ kind: 'zerowidth', cover: 'nothing to see here at all' }]), [{ kind: 'zerowidth', cover: '' }]) === secret
  out.guess = autoDecode(encodeAll(secret, [{ kind: 'caesar', shift: 5 }]))[0]?.result === secret
  const c = new OffscreenCanvas(120, 80)
  const g = c.getContext('2d')!
  g.fillStyle = '#48c'
  g.fillRect(0, 0, 120, 80)
  const { pixels } = lsbEmbed(g.getImageData(0, 0, 120, 80), secret)
  out.lsb = lsbExtract(pixels) === secret
  g.putImageData(pixels, 0, 0)
  const png = pngAddText(new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()), 'Comment', secret)
  out.pngText = pngReadText(png).some((t) => t.text === secret)
  const bmp = await createImageBitmap(new Blob([png as BlobPart]))
  const c2 = new OffscreenCanvas(bmp.width, bmp.height)
  c2.getContext('2d')!.drawImage(bmp, 0, 0)
  out.lsbAfterPng = lsbExtract(c2.getContext('2d')!.getImageData(0, 0, bmp.width, bmp.height)) === secret
  const { wav, seconds } = textToWav({ text: 'HELLO' })
  out.wav = wavToSamples(wav).samples.length === Math.round(seconds * 44100)
  return out
}

export default function MysteryMaker() {
  const [tab, setTab] = useState<Tab>('build')
  return (
    <Stack gap={16}>
      <Segmented<Tab>
        value={tab}
        onChange={setTab}
        options={[
          { value: 'build', label: 'Build a trail', icon: Puzzle },
          { value: 'decode', label: 'Decode anything', icon: Eye },
        ]}
      />
      {tab === 'build' ? <Builder /> : <Decoder />}
    </Stack>
  )
}

// ---------------------------------------------------------------- builder

function Builder() {
  const api = useBackend('mystery-maker')
  const toast = useToast()
  const [trail, setTrail] = useState<Trail>({ name: 'Untitled trail', steps: [] })
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const saveTimer = useRef(0)

  useEffect(() => {
    core.getUtilSettings<{ trail: Trail }>('mystery-maker').then((s) => {
      if (s.trail?.steps) {
        setTrail(s.trail)
        setSelected(s.trail.steps[0]?.id ?? null)
      }
      setLoaded(true)
    })
  }, [])
  useEffect(() => {
    if (!loaded) return
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => core.setUtilSettings('mystery-maker', { trail }), 400)
  }, [trail, loaded])

  const update = (id: string, patch: Partial<Step>) => setTrail((t) => ({ ...t, steps: t.steps.map((s) => (s.id === id ? ({ ...s, ...patch } as Step) : s)) }))
  const add = (kind: StepKind) => {
    const step = makeStep(kind)
    setTrail((t) => ({ ...t, steps: [...t.steps, step] }))
    setSelected(step.id)
  }
  const move = (id: string, dir: -1 | 1) =>
    setTrail((t) => {
      const i = t.steps.findIndex((s) => s.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= t.steps.length) return t
      const steps = [...t.steps]
      ;[steps[i], steps[j]] = [steps[j], steps[i]]
      return { ...t, steps }
    })
  const remove = (id: string) => {
    setTrail((t) => ({ ...t, steps: t.steps.filter((s) => s.id !== id) }))
    setSelected((s) => (s === id ? null : s))
  }

  const exportTrail = async () => {
    if (!trail.steps.length) return
    const folder = await core.pickFolder({ title: 'Where should the trail be written?' })
    if (!folder) return
    setBusy('Building…')
    try {
      const result = await buildTrail(trail, {
        loadCover: async (p) => {
          try {
            return await createImageBitmap(new Blob([(await core.readFile(p)) as BlobPart]))
          } catch {
            return null
          }
        },
      })
      const safeName = trail.name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'trail'
      const root = `${folder}\\${safeName}`
      let bytes = 0
      for (const [i, f] of result.files.entries()) {
        setBusy(`Writing ${i + 1} of ${result.files.length}`)
        await core.writeFile(`${root}\\${f.path.replaceAll('/', '\\')}`, f.data)
        bytes += f.data.length
      }
      await core.writeFile(`${folder}\\${safeName} — SOLUTION.txt`, new TextEncoder().encode(result.solution))
      if (result.hiddenDirs.length) await api.invoke('hide', { paths: result.hiddenDirs.map((d) => `${root}\\${d.replaceAll('/', '\\')}`) })
      for (const w of result.warnings) toast.warn(w)
      toast.ok(`Trail written: ${formatCount(result.files.length, 'file')}`, { detail: `${formatBytes(bytes)} in ${root} · the SOLUTION.txt next to it is for you only`, action: { label: 'Show', run: () => core.reveal(root) } })
    } catch (err) {
      toast.error('Could not build the trail', { detail: errorMessage(err) })
    } finally {
      setBusy(null)
    }
  }

  const current = trail.steps.find((s) => s.id === selected) ?? null
  const zipIndex = trail.steps.findIndex((s) => s.kind === 'zip')

  return (
    <div className="mm">
      <Panel
        flush
        title={
          <span className="mm__name">
            <input value={trail.name} onChange={(e) => setTrail((t) => ({ ...t, name: e.target.value }))} placeholder="Name of the hunt" aria-label="Trail name" />
          </span>
        }
        actions={
          trail.steps.length === 0 ? (
            <Button size="sm" variant="ghost" icon={Wand2} onClick={() => { const ex = exampleTrail(); setTrail(ex); setSelected(ex.steps[0].id) }}>
              Load example
            </Button>
          ) : (
            <Button size="sm" variant="ghost" icon={Trash2} onClick={() => { setTrail({ name: trail.name, steps: [] }); setSelected(null) }}>
              Clear
            </Button>
          )
        }
      >
        <div className="mm__steps">
          {trail.steps.length === 0 && (
            <Empty icon={Puzzle} title="No steps yet">
              Add steps below, or load the example to see how a full hunt fits together.
            </Empty>
          )}
          {trail.steps.map((s, i) => {
            const Icon = ICONS[s.kind]
            const inZip = zipIndex >= 0 && i > zipIndex
            return (
              <button key={s.id} type="button" className={cx('mm__step', s.id === selected && 'is-selected', inZip && 'is-inside')} onClick={() => setSelected(s.id)}>
                <span className="mm__num">{i + 1}</span>
                <Icon size={15} />
                <span className="mm__step-text">
                  <span>{s.title || KINDS.find((k) => k.kind === s.kind)!.label}</span>
                  <span>{s.kind === 'zip' ? (s.password ? `password: ${s.password}` : 'no password') : s.message.split('\n')[0] || '—'}</span>
                </span>
              </button>
            )
          })}
        </div>
        <div className="mm__add">
          <div className="mm__add-label">Add a step</div>
          <div className="mm__add-grid">
            {KINDS.map((k) => {
              const Icon = ICONS[k.kind]
              return (
                <button key={k.kind} type="button" className="mm__add-btn" onClick={() => add(k.kind)} title={k.blurb}>
                  <Plus size={12} /> <Icon size={13} /> {k.label}
                </button>
              )
            })}
          </div>
        </div>
        <div className="mm__export">
          {busy ? (
            <Progress value={null} label={busy} />
          ) : (
            <Button variant="primary" size="lg" block icon={FolderOutput} disabled={!trail.steps.length} onClick={exportTrail}>
              Export the trail…
            </Button>
          )}
        </div>
      </Panel>

      <div className="mm__editor">
        {current ? (
          <StepEditor step={current} index={trail.steps.indexOf(current)} total={trail.steps.length} onChange={(patch) => update(current.id, patch)} onMove={(d) => move(current.id, d)} onRemove={() => remove(current.id)} />
        ) : (
          <Panel>
            <Empty icon={Puzzle} title="How it works">
              Each step hides a message; that message is usually what the player needs for the next step (a password, where to look, a link). Put a <strong>Locked zip</strong> in the middle and everything after it lands inside the zip. Export writes the whole trail as files, plus a SOLUTION.txt for you.
            </Empty>
          </Panel>
        )}
      </div>
    </div>
  )
}

function StepEditor({ step, index, total, onChange, onMove, onRemove }: { step: Step; index: number; total: number; onChange: (patch: Partial<Step>) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void }) {
  const kind = KINDS.find((k) => k.kind === step.kind)!
  const Icon = ICONS[step.kind]
  return (
    <Panel
      title={
        <span className="mm__editor-title">
          <Icon size={16} /> Step {index + 1} · {kind.label}
        </span>
      }
      hint={kind.blurb}
      actions={
        <Row gap={2}>
          <IconButton icon={ArrowUp} label="Move up" disabled={index === 0} onClick={() => onMove(-1)} />
          <IconButton icon={ArrowDown} label="Move down" disabled={index === total - 1} onClick={() => onMove(1)} />
          <IconButton icon={Trash2} label="Remove step" onClick={onRemove} />
        </Row>
      }
    >
      <Stack gap={14}>
        <Row gap={12}>
          <Field label="Title (for you, and folder/page names)">
            <TextInput value={step.title} onChange={(title) => onChange({ title })} />
          </Field>
          {step.kind !== 'folder' ? (
            <Field label="File name">
              <TextInput value={step.filename} onChange={(filename) => onChange({ filename })} mono />
            </Field>
          ) : (
            <Field label="Name of the real file">
              <TextInput value={step.filename} onChange={(filename) => onChange({ filename })} mono />
            </Field>
          )}
        </Row>

        {step.kind !== 'zip' && (
          <Field label={step.kind === 'final' ? 'Final words' : step.kind === 'qr' ? 'What the code contains (a link, or text)' : step.kind === 'audio' ? 'Word(s) to spell out — short and CAPITALS read best' : 'The hidden message (usually the clue or password for the next step)'}>
            <TextArea value={step.message} onChange={(message) => onChange({ message })} rows={step.kind === 'audio' || step.kind === 'qr' ? 2 : 4} mono={false} />
          </Field>
        )}

        {step.kind === 'cipher' && <CipherEditor step={step} onChange={onChange} />}
        {step.kind === 'image' && <ImageEditor step={step} onChange={onChange} />}
        {step.kind === 'audio' && <AudioPreview text={step.message} />}
        {step.kind === 'zip' && (
          <Field label="Password" hint="Everything after this step is packed inside the zip. Leave empty for an unlocked zip.">
            <TextInput value={step.password} onChange={(password) => onChange({ password })} mono />
          </Field>
        )}
        {step.kind === 'folder' && (
          <Row gap={16} wrap>
            <Field label="Junk files">
              <NumberInput value={step.decoys} onChange={(decoys) => onChange({ decoys })} min={0} max={400} width={100} />
            </Field>
            <Field label="Folder depth">
              <NumberInput value={step.depth} onChange={(depth) => onChange({ depth })} min={1} max={8} width={100} />
            </Field>
            <Field label="Hide the top folder" hint="Needs “Show hidden items” in Explorer." inline>
              <Toggle checked={step.hidden} onChange={(hidden) => onChange({ hidden })} />
            </Field>
          </Row>
        )}
        {step.kind === 'final' && (
          <Field label="Video or page link" hint="An unlisted YouTube video works best: anyone with the link can watch, nobody can find it by searching. (A private video would block them.)">
            <TextInput value={step.url} onChange={(url) => onChange({ url })} mono placeholder="https://www.youtube.com/watch?v=…" />
          </Field>
        )}
      </Stack>
    </Panel>
  )
}

function CipherEditor({ step, onChange }: { step: Extract<Step, { kind: 'cipher' }>; onChange: (patch: Partial<Step>) => void }) {
  const [adding, setAdding] = useState<Layer['kind']>('base64')
  const setLayer = (i: number, layer: Layer) => onChange({ layers: step.layers.map((l, j) => (j === i ? layer : l)) })
  const encoded = useMemo(() => {
    try {
      return encodeAll(step.message, step.layers)
    } catch (err) {
      return 'cannot encode: ' + errorMessage(err)
    }
  }, [step.message, step.layers])
  return (
    <Stack gap={12}>
      <div className="mm__layers">
        <div className="mm__label">Layers, applied in this order</div>
        {step.layers.map((layer, i) => (
          <div key={i} className="mm__layer">
            <Badge tone="accent">{i + 1}</Badge>
            <span className="mm__layer-name">{LAYER_KINDS.find((k) => k.kind === layer.kind)!.label}</span>
            {layer.kind === 'caesar' && <NumberInput value={layer.shift} onChange={(shift) => setLayer(i, { kind: 'caesar', shift })} min={1} max={25} width={80} />}
            {layer.kind === 'vigenere' && <TextInput value={layer.key} onChange={(key) => setLayer(i, { kind: 'vigenere', key })} mono placeholder="KEYWORD" />}
            {layer.kind === 'zerowidth' && <TextInput value={layer.cover} onChange={(cover) => setLayer(i, { kind: 'zerowidth', cover })} placeholder="Innocent cover sentence" />}
            <IconButton icon={X} label="Remove layer" onClick={() => onChange({ layers: step.layers.filter((_, j) => j !== i) })} />
          </div>
        ))}
        <Row gap={6}>
          <Select<Layer['kind']> value={adding} onChange={setAdding} options={LAYER_KINDS.map((k) => ({ value: k.kind, label: k.label }))} />
          <Button
            size="sm"
            icon={Plus}
            onClick={() => {
              const l: Layer = adding === 'caesar' ? { kind: 'caesar', shift: 3 } : adding === 'vigenere' ? { kind: 'vigenere', key: 'SECRET' } : adding === 'zerowidth' ? { kind: 'zerowidth', cover: 'Nothing to see here.' } : { kind: adding } as Layer
              onChange({ layers: [...step.layers, l] })
            }}
          >
            Add layer
          </Button>
        </Row>
        <p className="mm__hint">{LAYER_KINDS.find((k) => k.kind === adding)!.hint}</p>
      </div>
      <Field label="Hint written under the cipher (optional)">
        <TextInput value={step.hint} onChange={(hint) => onChange({ hint })} placeholder="e.g. Julius would know" />
      </Field>
      <Field label="What the player will see">
        <TextArea value={encoded} readOnly rows={3} />
      </Field>
    </Stack>
  )
}

function ImageEditor({ step, onChange }: { step: Extract<Step, { kind: 'image' }>; onChange: (patch: Partial<Step>) => void }) {
  return (
    <Stack gap={12}>
      <Field label="Cover picture" hint="Any photo. Leave empty and a moody generated frame is used. The output is always a PNG (JPEG would destroy the hidden bits).">
        {step.coverPath ? (
          <PathChip path={step.coverPath} icon={ImageIcon} onClear={() => onChange({ coverPath: null })} />
        ) : (
          <Dropzone compact title="Drop a picture" hint="or browse" icon={ImageIcon} filters={[{ name: 'Picture', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]} strict onPaths={(p) => onChange({ coverPath: p[0] })} />
        )}
      </Field>
      <Field label="Where to hide it">
        <Segmented<'lsb' | 'text' | 'both'>
          block
          size="sm"
          value={step.method}
          onChange={(method) => onChange({ method })}
          options={[
            { value: 'lsb', label: 'In the pixels (hard)' },
            { value: 'text', label: 'In the metadata (easy)' },
            { value: 'both', label: 'Both' },
          ]}
        />
      </Field>
    </Stack>
  )
}

function AudioPreview({ text }: { text: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [seconds, setSeconds] = useState(0)
  const [wav, setWav] = useState<Uint8Array | null>(null)
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!text.trim() || !canvasRef.current) return
      const res = textToWav({ text: text.trim().slice(0, 40) })
      setWav(res.wav)
      setSeconds(res.seconds)
      const { samples, sampleRate } = wavToSamples(res.wav)
      drawSpectrogram(canvasRef.current, samples, sampleRate, 9000)
    }, 250)
    return () => window.clearTimeout(t)
  }, [text])
  const play = () => {
    if (!wav) return
    const url = URL.createObjectURL(new Blob([wav as BlobPart], { type: 'audio/wav' }))
    const a = new Audio(url)
    a.onended = () => URL.revokeObjectURL(url)
    void a.play()
  }
  return (
    <Field label={`How it looks in a spectrogram${seconds ? ` (${seconds.toFixed(1)} s)` : ''}`} hint="This is what the player sees in Audacity’s spectrogram view. To the ear it is just eerie tones.">
      <div className="mm__spectro">
        <canvas ref={canvasRef} />
        <Button size="sm" variant="ghost" icon={AudioLines} onClick={play} disabled={!wav}>
          Play
        </Button>
      </div>
    </Field>
  )
}

// ---------------------------------------------------------------- decoder

function Decoder() {
  const toast = useToast()
  const [text, setText] = useState('')
  const [key, setKey] = useState('')
  const [imageResult, setImageResult] = useState<string[] | null>(null)
  const [imagePath, setImagePath] = useState<string | null>(null)
  const [wavPath, setWavPath] = useState<string | null>(null)
  const spectroRef = useRef<HTMLCanvasElement>(null)
  const guesses = useMemo(() => (text.trim() ? autoDecode(text, key) : []), [text, key])

  const loadImage = useCallback(
    async (p: string) => {
      try {
        const bytes = await core.readFile(p)
        const found: string[] = []
        for (const t of pngReadText(bytes)) found.push(`Metadata "${t.keyword}": ${t.text}`)
        const bmp = await createImageBitmap(new Blob([bytes as BlobPart]))
        const c = new OffscreenCanvas(bmp.width, bmp.height)
        const g = c.getContext('2d')!
        g.drawImage(bmp, 0, 0)
        const lsb = lsbExtract(g.getImageData(0, 0, bmp.width, bmp.height))
        if (lsb) found.push(`In the pixels: ${lsb}`)
        setImagePath(p)
        setImageResult(found)
      } catch (err) {
        toast.error('Could not read that picture', { detail: errorMessage(err) })
      }
    },
    [toast],
  )

  const loadWav = useCallback(
    async (p: string) => {
      try {
        const { samples, sampleRate } = wavToSamples(await core.readFile(p))
        if (spectroRef.current) drawSpectrogram(spectroRef.current, samples, sampleRate, 10000)
        setWavPath(p)
      } catch (err) {
        toast.error('Could not read that WAV', { detail: errorMessage(err) })
      }
    },
    [toast],
  )

  return (
    <div className="mm__decode">
      <Panel title="Text" hint="Paste anything suspicious. Every cipher is tried; likeliest first.">
        <Stack gap={10}>
          <TextArea value={text} onChange={setText} rows={5} placeholder="Paste the cipher text here…" />
          <Row gap={8} wrap>
            <Field label="Vigenère key, if you have one" inline>
              <TextInput value={key} onChange={setKey} mono placeholder="KEYWORD" />
            </Field>
            {text && stripZeroWidth(text) !== text && <Badge tone="warn">contains invisible characters</Badge>}
          </Row>
          {guesses.length > 0 && (
            <div className="mm__guesses">
              {guesses.slice(0, 14).map((g, i) => (
                <div key={i} className={cx('mm__guess', i === 0 && 'is-best')}>
                  <span className="mm__guess-method">{g.method}</span>
                  <code>{g.result.slice(0, 300)}</code>
                </div>
              ))}
            </div>
          )}
          {text.trim() && !guesses.length && <p className="mm__hint">Nothing readable came out. It may need a key, or it is not text at all.</p>}
        </Stack>
      </Panel>
      <Stack gap={16}>
        <Panel title="Picture" hint="Finds messages in PNG metadata and in the pixels (this tool’s LSB format).">
          <Stack gap={10}>
            {imagePath ? <PathChip path={imagePath} icon={ImageIcon} onClear={() => { setImagePath(null); setImageResult(null) }} /> : null}
            <Dropzone compact title={imagePath ? 'Check another picture' : 'Drop a PNG'} icon={ImageIcon} filters={[{ name: 'PNG', extensions: ['png'] }]} strict onPaths={(p) => loadImage(p[0])} />
            {imageResult && (imageResult.length ? imageResult.map((r) => <Notice key={r} tone="ok">{r}</Notice>) : <Notice tone="info">Nothing hidden that this tool knows how to read.</Notice>)}
          </Stack>
        </Panel>
        <Panel title="Sound" hint="Shows the spectrogram, where words hide.">
          <Stack gap={10}>
            <Dropzone compact title={wavPath ? baseName(wavPath) : 'Drop a WAV'} icon={AudioLines} filters={[{ name: 'WAV', extensions: ['wav'] }]} strict onPaths={(p) => loadWav(p[0])} />
            <div className={cx('mm__spectro', !wavPath && 'is-empty')}>
              <canvas ref={spectroRef} />
            </div>
          </Stack>
        </Panel>
      </Stack>
    </div>
  )
}
