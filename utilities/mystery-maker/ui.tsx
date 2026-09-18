import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, AudioLines, DoorClosed, Eye, FileText, Flag, Folder, FolderOutput, FolderTree, Globe, Image as ImageIcon, KeyRound, ListOrdered, Lock, Plus, Puzzle, QrCode, Shuffle, Trash2, Wand2 } from 'lucide-react'
import { core, errorMessage } from '@/lib/bridge'
import { baseName, cx, formatBytes, formatCount } from '@/lib/format'
import { drawQr, qrMatrix } from '@/lib/qr'
import { useToast } from '@/components/Toasts'
import { Dropzone, PathChip } from '@/components/Dropzone'
import { Badge, Button, CopyButton, Empty, Field, IconButton, Notice, NumberInput, Panel, Progress, Row, Segmented, Select, Stack, TextArea, TextInput, Toggle } from '@/components/ui'
import { autoDecode, decodeAll, encodeAll, stripZeroWidth, type Layer } from './lib/ciphers'
import { lsbEmbed, lsbExtract, pngAddText, pngReadText } from './lib/stego'
import { drawSpectrogram, textToWav, wavToSamples } from './lib/spectro'
import { buildChain, emptyChain, gateBlob, gateOpen, howSolved, kindLabel, layersFor, makeStage, messageOf, needsWord, normalizeChain, pointer, preset, problems, randomSlug, randomWord, slugOf, STAGE_KINDS, startNote, storyboard, whereIs, wordLabel, youtubeId, type Chain, type CipherPreset, type Difficulty, type HuntMode, type Stage, type StageKind } from './lib/chain'
import './ui.css'

type Tab = 'build' | 'decode'
type Selection = 'start' | 'finale' | string

const ICONS: Record<StageKind, typeof FileText> = { cipher: KeyRound, image: ImageIcon, audio: AudioLines, zip: Lock, gate: DoorClosed, qr: QrCode, folder: FolderTree }
const CIPHERS: Array<{ value: CipherPreset; label: string; blurb: string }> = [
  { value: 'caesar', label: 'Caesar shift', blurb: 'Letters shifted along the alphabet. Easy: any online tool cracks it.' },
  { value: 'base64', label: 'Base64', blurb: 'Looks like gibberish; decoders everywhere. Easy.' },
  { value: 'morse', label: 'Morse', blurb: 'Dots and dashes. Easy but slow.' },
  { value: 'vigenere', label: 'Vigenère + keyword', blurb: 'Unbreakable without the keyword; the previous stage tells it. Medium.' },
  { value: 'invisible', label: 'Invisible ink', blurb: 'Zero-width characters hidden inside an innocent sentence. Hard to even notice.' },
  { value: 'mix', label: 'Three layers', blurb: 'Reversed, Base64, then Vigenère with the keyword. Hard.' },
]

// lets the screenshot run prove the engines and the chain wiring inside the built app
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
  out.gate = (await gateOpen(await gateBlob('Lantern42', 'Go to https://x.test/abc/'), ' LANTERN42 ')) === 'Go to https://x.test/abc/'
  out.gateWrong = await gateOpen(await gateBlob('Lantern42', 'x'), 'nope').then(() => false, () => true)

  // the chain: every stage's hidden message must name the next stage's file and its password
  const chain: Chain = { ...emptyChain(), name: 'Test', stages: preset('medium', 'files') }
  const s = chain.stages
  out.startPointsAtFirst = startNote(chain).includes(whereIs(chain, 0))
  out.audioSpellsNextWord = pointer(chain, 1) === s[2].word && s[2].kind === 'zip'
  out.zipMessageHasKeyword = messageOf(chain, 2).includes(`keyword: ${s[3].word}`) && messageOf(chain, 2).includes(whereIs(chain, 3))
  out.lastPointsAtFinale = messageOf(chain, 4).includes('the end.html')
  const built = await buildChain(chain, { loadCover: async () => null })
  const names = built.files.map((f) => f.path)
  out.builtFiles = names[0] === 'START.txt' && names.includes(whereIs(chain, 0)) && names.includes(whereIs(chain, 1)) && names.includes(whereIs(chain, 2)) && names.length === 4 // the zip swallows the rest
  const site: Chain = { ...chain, mode: 'site', siteUrl: 'https://hunt.test', stages: preset('medium', 'site') }
  const builtSite = await buildChain(site, { loadCover: async () => null })
  const siteNames = builtSite.files.map((f) => f.path)
  out.siteFiles = siteNames.includes('START.txt') && siteNames.includes(`site/${slugOf(site, 0)}/index.html`) && siteNames.includes(`site/${slugOf(site, 2)}/index.html`) && new TextDecoder().decode(builtSite.files.find((f) => f.path === 'START.txt')!.data).includes(`https://hunt.test/${slugOf(site, 0)}/`)
  out.siteWarnings = builtSite.warnings
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
          { value: 'build', label: 'Make a hunt', icon: Puzzle },
          { value: 'decode', label: 'Decode anything', icon: Eye },
        ]}
      />
      {tab === 'build' ? <Builder /> : <Decoder />}
    </Stack>
  )
}

// ---------------------------------------------------------------- builder

function Builder() {
  const toast = useToast()
  const [chain, setChain] = useState<Chain>(emptyChain)
  const [selected, setSelected] = useState<Selection>('start')
  const [busy, setBusy] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const saveTimer = useRef(0)

  useEffect(() => {
    core.getUtilSettings<{ chain: Chain }>('mystery-maker').then((s) => {
      if (s.chain) setChain(normalizeChain(s.chain))
      setLoaded(true)
    })
  }, [])
  useEffect(() => {
    if (!loaded) return
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => core.setUtilSettings('mystery-maker', { chain }), 400)
  }, [chain, loaded])

  const patch = (p: Partial<Chain>) => setChain((c) => ({ ...c, ...p }))
  const update = (id: string, p: Partial<Stage>) => setChain((c) => ({ ...c, stages: c.stages.map((s) => (s.id === id ? { ...s, ...p } : s)) }))
  const add = (kind: StageKind) => {
    const stage = makeStage(kind)
    setChain((c) => ({ ...c, stages: [...c.stages, stage] }))
    setSelected(stage.id)
  }
  const move = (id: string, dir: -1 | 1) =>
    setChain((c) => {
      const i = c.stages.findIndex((s) => s.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= c.stages.length) return c
      const stages = [...c.stages]
      ;[stages[i], stages[j]] = [stages[j], stages[i]]
      return { ...c, stages }
    })
  const remove = (id: string) => {
    setChain((c) => ({ ...c, stages: c.stages.filter((s) => s.id !== id) }))
    setSelected('start')
  }
  const setMode = (mode: HuntMode) =>
    setChain((c) => ({ ...c, mode, stages: c.stages.map((s) => (mode === 'files' && s.kind === 'gate' ? { ...s, kind: 'zip' } : mode === 'site' && s.kind === 'zip' ? { ...s, kind: 'gate' } : s)) }))
  const useTemplate = (level: Difficulty) => {
    const stages = preset(level, chain.mode)
    setChain((c) => ({ ...c, stages }))
    setSelected('start')
  }

  const issues = useMemo(() => problems(chain), [chain])

  const exportChain = async () => {
    const folder = await core.pickFolder({ title: 'Where should the hunt be written?' })
    if (!folder) return
    setBusy('Building…')
    try {
      const result = await buildChain(chain, {
        loadCover: async (p) => {
          try {
            return await createImageBitmap(new Blob([(await core.readFile(p)) as BlobPart]))
          } catch {
            return null
          }
        },
      })
      const safeName = chain.name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'hunt'
      const root = `${folder}\\${safeName}`
      let bytes = 0
      for (const [i, f] of result.files.entries()) {
        setBusy(`Writing ${i + 1} of ${result.files.length}`)
        await core.writeFile(`${root}\\${f.path.replaceAll('/', '\\')}`, f.data)
        bytes += f.data.length
      }
      await core.writeFile(`${folder}\\${safeName} — SOLUTION.txt`, new TextEncoder().encode(result.solution))
      for (const w of result.warnings) toast.warn(w)
      toast.ok(`Hunt written: ${formatCount(result.files.length, 'file')} · ${formatBytes(bytes)}`, {
        detail: chain.mode === 'site' ? `Upload the "site" folder to ${chain.siteUrl || 'your website'}, then hand out START.txt. The SOLUTION.txt next to the folder is for you only.` : `Hand out the whole "${safeName}" folder; START.txt is the way in. The SOLUTION.txt next to it is for you only.`,
        action: { label: 'Show', run: () => core.reveal(root) },
      })
    } catch (err) {
      toast.error('Could not build the hunt', { detail: errorMessage(err) })
    } finally {
      setBusy(null)
    }
  }

  const current = chain.stages.find((s) => s.id === selected) ?? null
  const zipIndex = chain.mode === 'files' ? chain.stages.findIndex((s) => s.kind === 'zip') : -1

  return (
    <div className="mm">
      <Panel
        flush
        title={
          <span className="mm__name">
            <input value={chain.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Name of the hunt" aria-label="Hunt name" />
          </span>
        }
        actions={
          chain.stages.length > 0 && (
            <Button size="sm" variant="ghost" icon={Trash2} onClick={() => { setChain((c) => ({ ...emptyChain(), name: c.name, mode: c.mode, siteUrl: c.siteUrl })); setSelected('start') }}>
              Clear
            </Button>
          )
        }
      >
        <div className="mm__mode">
          <Segmented<HuntMode>
            block
            size="sm"
            value={chain.mode}
            onChange={setMode}
            options={[
              { value: 'files', label: 'Folder of files', icon: Folder },
              { value: 'site', label: 'Website', icon: Globe },
            ]}
          />
          <p className="mm__hint">{chain.mode === 'files' ? 'Everything is files in one folder you hand out (or zip). Works offline.' : 'Every stage is a hidden page. You only hand out START.txt; the pages live at an address only the clues reveal.'}</p>
          {chain.mode === 'site' && (
            <Field label="Where the pages will live" hint="Every clue says “go to <this address>/…”, so it has to be known before you export. Free options: Netlify Drop (drag the exported site folder onto app.netlify.com/drop) or GitHub Pages.">
              <TextInput value={chain.siteUrl} onChange={(siteUrl) => patch({ siteUrl })} mono placeholder="https://something.netlify.app" />
            </Field>
          )}
        </div>

        <div className="mm__steps">
          <button type="button" className={cx('mm__step', selected === 'start' && 'is-selected')} onClick={() => setSelected('start')}>
            <span className="mm__num mm__num--start">
              <FileText size={12} />
            </span>
            <span className="mm__step-text">
              <span>START.txt</span>
              <span>the one thing you hand out</span>
            </span>
          </button>
          {chain.stages.map((s, i) => {
            const Icon = ICONS[s.kind]
            const inZip = zipIndex >= 0 && i > zipIndex
            return (
              <button key={s.id} type="button" className={cx('mm__step', s.id === selected && 'is-selected', inZip && 'is-inside')} onClick={() => setSelected(s.id)}>
                <span className="mm__num">{i + 1}</span>
                <Icon size={15} />
                <span className="mm__step-text">
                  <span>{s.title || kindLabel(s.kind)}</span>
                  <span>{needsWord(s) ? `${wordLabel(s)}: ${s.word}` : s.kind === 'audio' ? `spells ${pointer(chain, i)}` : kindLabel(s.kind)}</span>
                </span>
              </button>
            )
          })}
          <button type="button" className={cx('mm__step', selected === 'finale' && 'is-selected', zipIndex >= 0 && 'is-inside')} onClick={() => setSelected('finale')}>
            <span className="mm__num mm__num--end">
              <Flag size={12} />
            </span>
            <span className="mm__step-text">
              <span>Finale</span>
              <span>{youtubeId(chain.finale.url) ? 'unlisted YouTube video' : chain.finale.url ? chain.finale.url : 'a last page'}</span>
            </span>
          </button>
        </div>

        {chain.stages.length === 0 && (
          <div className="mm__add">
            <div className="mm__add-label">Start from a template</div>
            <Row gap={5}>
              <Button size="sm" icon={Wand2} onClick={() => useTemplate('easy')}>Easy</Button>
              <Button size="sm" icon={Wand2} onClick={() => useTemplate('medium')}>Medium</Button>
              <Button size="sm" icon={Wand2} onClick={() => useTemplate('hard')}>Hard</Button>
            </Row>
          </div>
        )}
        <div className="mm__add">
          <div className="mm__add-label">Add a stage</div>
          <div className="mm__add-grid">
            {STAGE_KINDS.filter((k) => !k.siteOnly || chain.mode === 'site').map((k) => {
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
            <Button variant="primary" size="lg" block icon={FolderOutput} disabled={!chain.stages.length} onClick={exportChain}>
              Export the hunt…
            </Button>
          )}
        </div>
      </Panel>

      <Stack gap={16}>
        {issues.length > 0 && (
          <Notice tone="warn" title={issues.length === 1 ? 'One thing to fix' : `${issues.length} things to fix`}>
            <ul className="mm__issues">
              {issues.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Notice>
        )}
        {selected === 'start' ? (
          <StartEditor chain={chain} onChange={patch} />
        ) : selected === 'finale' ? (
          <FinaleEditor chain={chain} onChange={patch} />
        ) : current ? (
          <StageEditor chain={chain} stage={current} index={chain.stages.indexOf(current)} onChange={(p) => update(current.id, p)} onMove={(d) => move(current.id, d)} onRemove={() => remove(current.id)} />
        ) : null}
        <Walkthrough chain={chain} />
      </Stack>
    </div>
  )
}

function StartEditor({ chain, onChange }: { chain: Chain; onChange: (p: Partial<Chain>) => void }) {
  const note = startNote(chain)
  return (
    <Panel title="START.txt" hint="The only thing the player gets. It leads to stage 1; stage 1 leads to stage 2; and so on to the finale." actions={<CopyButton text={note} />}>
      <Stack gap={14}>
        <Field label="Opening words" hint="Set the mood. The pointer to the first stage is added underneath automatically.">
          <TextArea value={chain.intro} onChange={(intro) => onChange({ intro })} rows={3} mono={false} placeholder="Someone left this behind on purpose…" />
        </Field>
        <Field label="What the note will say">
          <TextArea value={note.trim()} readOnly rows={4} />
        </Field>
        {chain.stages.length === 0 && (
          <Empty icon={Puzzle} title="No stages yet">
            Pick a template on the left, or add stages one by one. Each stage hides the way to the next one; you never write the “go to…” parts yourself.
          </Empty>
        )}
      </Stack>
    </Panel>
  )
}

function FinaleEditor({ chain, onChange }: { chain: Chain; onChange: (p: Partial<Chain>) => void }) {
  const f = chain.finale
  const set = (p: Partial<Chain['finale']>) => onChange({ finale: { ...f, ...p } })
  const lastIsAudio = chain.stages.length > 0 && chain.stages[chain.stages.length - 1].kind === 'audio'
  return (
    <Panel title="Finale" hint={`Where the last stage sends them: ${whereIs(chain, chain.stages.length)}`}>
      <Stack gap={14}>
        <Field label="Final words">
          <TextArea value={f.message} onChange={(message) => set({ message })} rows={3} mono={false} />
        </Field>
        <Field label="Video or link" hint="An unlisted YouTube video is perfect: anyone with the link can watch, nobody can find it by searching. (A private video would block them.) The finale page embeds it.">
          <TextInput value={f.url} onChange={(url) => set({ url })} mono placeholder="https://www.youtube.com/watch?v=…" />
        </Field>
        {youtubeId(f.url) && <Badge tone="ok">YouTube video recognised · it will play inside the finale page</Badge>}
        {lastIsAudio && (
          <Field label="The word the last recording spells" hint="Because the last stage is a sound, the finale is found by this word.">
            <WordInput value={f.word} onChange={(word) => set({ word })} />
          </Field>
        )}
      </Stack>
    </Panel>
  )
}

function WordInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <Row gap={6}>
      <TextInput value={value} onChange={(v) => onChange(v.replace(/\s+/g, ''))} mono placeholder={placeholder ?? 'WORD'} />
      <IconButton icon={Shuffle} label="Pick a random word" onClick={() => onChange(randomWord())} />
    </Row>
  )
}

function StageEditor({ chain, stage, index, onChange, onMove, onRemove }: { chain: Chain; stage: Stage; index: number; onChange: (p: Partial<Stage>) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void }) {
  const kind = STAGE_KINDS.find((k) => k.kind === stage.kind)!
  const Icon = ICONS[stage.kind]
  const next = chain.stages[index + 1] as Stage | undefined
  const afterAudio = index > 0 && chain.stages[index - 1].kind === 'audio'
  const hidden = messageOf(chain, index)
  const isAudio = stage.kind === 'audio'
  return (
    <Panel
      title={
        <span className="mm__editor-title">
          <Icon size={16} /> Stage {index + 1} · {kind.label}
        </span>
      }
      hint={kind.blurb}
      actions={
        <Row gap={2}>
          <IconButton icon={ArrowUp} label="Move up" disabled={index === 0} onClick={() => onMove(-1)} />
          <IconButton icon={ArrowDown} label="Move down" disabled={index === chain.stages.length - 1} onClick={() => onMove(1)} />
          <IconButton icon={Trash2} label="Remove stage" onClick={onRemove} />
        </Row>
      }
    >
      <Stack gap={14}>
        <Row gap={12} wrap>
          <Field label="Title" hint={chain.mode === 'site' ? 'Shown on the page' : 'Becomes the file name'}>
            <TextInput value={stage.title} onChange={(title) => onChange({ title })} placeholder={kind.label} />
          </Field>
          {needsWord(stage) && (
            <Field label={stage.kind === 'cipher' ? 'Keyword' : 'Password'} hint={index === 0 ? 'START.txt tells the player this' : afterAudio ? 'The recording before spells this' : `Stage ${index} tells the player this`}>
              <WordInput value={stage.word} onChange={(word) => onChange({ word })} />
            </Field>
          )}
          {chain.mode === 'site' && !afterAudio && (
            <Field label="Address part" hint={`${chain.siteUrl.replace(/\/+$/, '') || '<your site>'}/${stage.slug}/`}>
              <Row gap={6}>
                <TextInput value={stage.slug} onChange={(slug) => onChange({ slug: slug.replace(/[^a-z0-9-]/gi, '').toLowerCase() })} mono />
                <IconButton icon={Shuffle} label="New random address" onClick={() => onChange({ slug: randomSlug() })} />
              </Row>
            </Field>
          )}
        </Row>

        {!isAudio && (
          <Field label="Story line" hint="What they read once they crack it. The “go to…” part is added underneath by itself.">
            <TextArea value={stage.story} onChange={(story) => onChange({ story })} rows={2} mono={false} placeholder={stage.kind === 'cipher' && stage.cipher === 'invisible' ? 'The innocent sentence the secret hides inside' : 'One or two lines…'} />
          </Field>
        )}

        {stage.kind === 'cipher' && (
          <Field label="Cipher" hint={CIPHERS.find((c) => c.value === stage.cipher)!.blurb}>
            <Select<CipherPreset> value={stage.cipher} onChange={(cipher) => onChange({ cipher })} options={CIPHERS.map((c) => ({ value: c.value, label: c.label }))} />
          </Field>
        )}
        {stage.kind === 'image' && <ImageEditor stage={stage} onChange={onChange} />}
        {stage.kind === 'folder' && (
          <Field label="Junk files" hint="The real note is in the deepest folder.">
            <NumberInput value={stage.decoys} onChange={(decoys) => onChange({ decoys })} min={5} max={400} width={100} />
          </Field>
        )}
        {isAudio && (
          <Notice tone="info" icon={AudioLines}>
            {next ? (
              <>
                The recording spells <strong>{pointer(chain, index)}</strong>: {needsWord(next) ? `the ${wordLabel(next)} of stage ${index + 2}` : chain.mode === 'site' ? `stage ${index + 2} lives at /${pointer(chain, index).toLowerCase()}/` : `stage ${index + 2} is the file called ${whereIs(chain, index + 1)}`}. Change the word on that stage.
              </>
            ) : (
              <>The recording spells <strong>{pointer(chain, index)}</strong>, which leads to the finale. Change the word on the finale.</>
            )}
          </Notice>
        )}
        {stage.kind === 'gate' && (
          <Notice tone="info" icon={DoorClosed}>
            The page asks for the password and decrypts the next link in the browser, so nobody can read it in the page source.
          </Notice>
        )}

        <Field label="Leave a small hint" inline hint={stage.kind === 'cipher' ? 'A bracketed nudge under the cipher text' : 'A faint line on the page (website hunts)'}>
          <Toggle checked={stage.hint} onChange={(hint) => onChange({ hint })} />
        </Field>

        <div className="mm__reveal">
          <div className="mm__label">{isAudio ? 'What the spectrogram shows' : 'What this stage hides'}</div>
          {isAudio ? <AudioPreview text={hidden} /> : stage.kind === 'qr' ? <QrPreview text={hidden} /> : stage.kind === 'cipher' ? <CipherPreview stage={stage} message={hidden} /> : null}
          {!isAudio && <TextArea value={hidden} readOnly rows={Math.min(6, hidden.split('\n').length + 1)} />}
          <p className="mm__hint">
            <strong>How they get it:</strong> {howSolved(stage)}
          </p>
        </div>
      </Stack>
    </Panel>
  )
}

function CipherPreview({ stage, message }: { stage: Stage; message: string }) {
  const encoded = useMemo(() => {
    try {
      return encodeAll(message, layersFor(stage))
    } catch (err) {
      return 'cannot encode: ' + errorMessage(err)
    }
  }, [message, stage])
  return (
    <Field label="What the player sees">
      <TextArea value={encoded} readOnly rows={3} />
    </Field>
  )
}

function QrPreview({ text }: { text: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!ref.current) return
    try {
      drawQr(ref.current, qrMatrix(text, 'M'), 180, { margin: 2, fg: '#000000', bg: '#ffffff', rounded: false })
    } catch {
      /* too long to encode; the export will complain */
    }
  }, [text])
  return <canvas ref={ref} className="mm__qr" />
}

function ImageEditor({ stage, onChange }: { stage: Stage; onChange: (p: Partial<Stage>) => void }) {
  return (
    <Stack gap={12}>
      <Field label="Cover picture" hint="Any photo. Leave empty and a moody generated frame is used. The output is always a PNG (JPEG would destroy the hidden bits).">
        {stage.coverPath ? (
          <PathChip path={stage.coverPath} icon={ImageIcon} onClear={() => onChange({ coverPath: null })} />
        ) : (
          <Dropzone compact title="Drop a picture" hint="or browse" icon={ImageIcon} filters={[{ name: 'Picture', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]} strict onPaths={(p) => onChange({ coverPath: p[0] })} />
        )}
      </Field>
      <Field label="Where to hide it">
        <Segmented<'lsb' | 'text' | 'both'>
          block
          size="sm"
          value={stage.imageMethod}
          onChange={(imageMethod) => onChange({ imageMethod })}
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
      const res = textToWav({ text: text.trim().slice(0, 24) })
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
    <Field label={`In Audacity’s spectrogram view${seconds ? ` (${seconds.toFixed(1)} s)` : ''}`} hint="To the ear it is just eerie tones.">
      <div className="mm__spectro">
        <canvas ref={canvasRef} />
        <Button size="sm" variant="ghost" icon={AudioLines} onClick={play} disabled={!wav}>
          Play
        </Button>
      </div>
    </Field>
  )
}

function Walkthrough({ chain }: { chain: Chain }) {
  const hops = useMemo(() => storyboard(chain), [chain])
  return (
    <Panel title="Walkthrough" hint="The whole hunt, in the order the player meets it. This is also what the SOLUTION.txt says." actions={<ListOrdered size={16} />}>
      <ol className="mm__hops">
        {hops.map((h, i) => (
          <li key={i} className="mm__hop">
            <div className="mm__hop-at">{h.at}</div>
            <pre className="mm__hop-says">{h.says}</pre>
            <div className="mm__hop-how">
              {h.how}
              {h.key && <Badge tone="accent">{h.key}</Badge>}
            </div>
          </li>
        ))}
      </ol>
    </Panel>
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
