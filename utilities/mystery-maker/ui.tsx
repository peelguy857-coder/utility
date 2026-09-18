import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, AudioLines, ChevronDown, ChevronRight, CloudUpload, DoorClosed, ExternalLink, Eye, Flag, Folder, FolderOutput, FolderTree, Globe, Image as ImageIcon, KeyRound, Link2, Lock, Plus, Puzzle, QrCode, Shuffle, Trash2, Wand2 } from 'lucide-react'
import { core, errorMessage, useBackend } from '@/lib/bridge'
import { baseName, cx, formatBytes, formatCount } from '@/lib/format'
import { drawQr, qrMatrix } from '@/lib/qr'
import { useToast } from '@/components/Toasts'
import { Dropzone, PathChip } from '@/components/Dropzone'
import { Badge, Button, CopyButton, Empty, Field, IconButton, Notice, NumberInput, Panel, Progress, Row, Segmented, Select, Stack, TextArea, TextInput, Toggle } from '@/components/ui'
import { autoDecode, decodeAll, encodeAll, stripZeroWidth, type Layer } from './lib/ciphers'
import { lsbEmbed, lsbExtract, pngAddText, pngReadText } from './lib/stego'
import { drawSpectrogram, textToWav, wavToSamples } from './lib/spectro'
import { buildChain, emptyChain, gateBlob, gateOpen, howSolved, kindLabel, layersFor, linked, lockedAt, makeStage, messageOf, needsWord, normalizeChain, placementOf, pointer, preset, problems, randomSlug, randomWord, siteEntries, slugOf, STAGE_KINDS, startNote, storyboard, whereIs, youtubeId, type Chain, type CipherPreset, type Difficulty, type HuntMode, type Stage, type StageKind, type Where } from './lib/chain'
import { buildZip } from './lib/zip'
import './ui.css'

type Tab = 'build' | 'decode'

const TOKEN_PAGE = 'https://app.netlify.com/user/applications#personal-access-tokens'
/** tests point the publishing calls at a mock server */
const netlifyApi = () => (window as unknown as { __netlifyApi?: string }).__netlifyApi

const ICONS: Record<StageKind, typeof Flag> = { cipher: KeyRound, image: ImageIcon, audio: AudioLines, zip: Lock, gate: DoorClosed, qr: QrCode, folder: FolderTree }
const LEVELS: Array<{ level: Difficulty; label: string; blurb: string }> = [
  { level: 'easy', label: 'Easy', blurb: 'a coded note, a picture, a locked file' },
  { level: 'medium', label: 'Medium', blurb: 'a picture, a sound, a password, a keyword cipher, a QR code' },
  { level: 'hard', label: 'Hard', blurb: 'eight puzzles, three-layer ciphers, a maze of junk files' },
]
const CIPHERS: Array<{ value: CipherPreset; label: string; blurb: string }> = [
  { value: 'caesar', label: 'Caesar shift', blurb: 'Letters shifted along the alphabet. Easy: any online tool cracks it.' },
  { value: 'base64', label: 'Base64', blurb: 'Looks like gibberish; decoders everywhere. Easy.' },
  { value: 'morse', label: 'Morse', blurb: 'Dots and dashes. Easy but slow.' },
  { value: 'vigenere', label: 'Vigenère + keyword', blurb: 'Unbreakable without the keyword; the previous puzzle tells it. Medium.' },
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
  const chain: Chain = { ...emptyChain(), name: 'Test', mode: 'files', stages: preset('medium', 'files') }
  const s = chain.stages
  out.startPointsAtFirst = startNote(chain).includes('Start with "The photo.png"')
  out.lockedAfterFirst = whereIs(chain, 1) === 'The recording.zip' && messageOf(chain, 0).includes(`Open "The recording.zip"\npassword: ${s[1].word}`)
  out.audioSpellsNextWord = pointer(chain, 1) === s[2].word && s[2].kind === 'zip'
  out.zipMessageHasKeyword = messageOf(chain, 2).includes(`keyword and zip password: ${s[3].word}`) && messageOf(chain, 2).includes('Open "The letter.zip"')
  out.lastPointsAtLockedFinale = messageOf(chain, 4).includes(`Open "the end.zip"\npassword: ${chain.finale.word}`)
  const built = await buildChain(chain, { loadCover: async () => null })
  const names = built.files.map((f) => f.path)
  out.builtFiles = names[0] === 'START.txt' && names.includes('The photo.png') && names.includes('The recording.zip') && names.includes('Locked.zip') && names.length === 4 // the zip swallows the rest
  const open: Chain = { ...chain, lockAll: false }
  out.unlockedNames = whereIs(open, 1) === 'The recording.wav' && whereIs(open, 5) === 'the end.html' && !messageOf(open, 0).includes('password')
  const site: Chain = { ...chain, mode: 'site', siteUrl: 'https://hunt.test', stages: preset('medium', 'site') }
  const builtSite = await buildChain(site, { loadCover: async () => null })
  const siteNames = builtSite.files.map((f) => f.path)
  out.siteFiles = siteNames.includes('START.txt') && siteNames.includes(`site/${slugOf(site, 0)}/index.html`) && siteNames.includes(`site/${slugOf(site, 2)}/index.html`) && new TextDecoder().decode(builtSite.files.find((f) => f.path === 'START.txt')!.data).includes(`https://hunt.test/${slugOf(site, 0)}/`)
  out.siteWarnings = builtSite.warnings
  // a stage at the maker's own link + a finale that is the video itself
  const own: Chain = { ...site, stages: site.stages.map((st, i) => (i === 3 ? { ...st, where: 'link', link: 'https://pastebin.test/abc' } : st)), finale: { ...site.finale, direct: true, url: 'https://youtu.be/dQw4w9WgXcQ' } }
  const builtOwn = await buildChain(own, { loadCover: async () => null })
  const ownNames = builtOwn.files.map((f) => f.path)
  out.ownLink = messageOf(own, 2).includes('Go to https://pastebin.test/abc') && ownNames.includes('elsewhere/The letter.txt') && ownNames.includes('elsewhere/PUT THESE ONLINE.txt') && !ownNames.some((n) => n.includes(own.stages[3].slug)) && messageOf(own, 4).includes('Go to https://youtu.be/dQw4w9WgXcQ') && !ownNames.some((n) => n.includes(own.finale.slug))
  out.ownWarnings = builtOwn.warnings
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

interface Saved {
  chain: Chain
  netlifyToken: string
  advanced: boolean
}

function Builder() {
  const toast = useToast()
  const api = useBackend('mystery-maker')
  const [chain, setChain] = useState<Chain>(emptyChain)
  const [token, setToken] = useState('')
  const [draft, setDraft] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const saveTimer = useRef(0)

  useEffect(() => {
    core.getUtilSettings<Saved>('mystery-maker').then((s) => {
      if (s.chain) setChain(normalizeChain(s.chain))
      if (typeof s.netlifyToken === 'string') setToken(s.netlifyToken)
      if (typeof s.advanced === 'boolean') setAdvanced(s.advanced)
      setLoaded(true)
    })
  }, [])
  useEffect(() => {
    if (!loaded) return
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => core.setUtilSettings<Saved>('mystery-maker', { chain, netlifyToken: token, advanced }), 400)
  }, [chain, token, advanced, loaded])

  const patch = (p: Partial<Chain>) => setChain((c) => ({ ...c, ...p }))
  const update = (id: string, p: Partial<Stage>) => setChain((c) => ({ ...c, stages: c.stages.map((s) => (s.id === id ? { ...s, ...p } : s)) }))
  const add = (kind: StageKind) => {
    const stage = makeStage(kind)
    setChain((c) => ({ ...c, stages: [...c.stages, stage] }))
    setOpen(stage.id)
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
    setOpen((o) => (o === id ? null : o))
  }
  const setMode = (mode: HuntMode) =>
    setChain((c) => ({ ...c, mode, stages: c.stages.map((s) => (mode === 'files' && s.kind === 'gate' ? { ...s, kind: 'zip' } : mode === 'site' && s.kind === 'zip' ? { ...s, kind: 'gate' } : s)) }))
  const useTemplate = (level: Difficulty) => {
    setChain((c) => ({ ...c, stages: preset(level, c.mode) }))
    setOpen(null)
  }

  const issues = useMemo(() => problems(chain), [chain])
  const connected = token.trim().length > 0
  const online = chain.mode === 'site' && !!chain.siteId && !!chain.siteUrl

  const loadCover = async (p: string) => {
    try {
      return await createImageBitmap(new Blob([(await core.readFile(p)) as BlobPart]))
    } catch {
      return null
    }
  }

  /** Puts the site on the internet: makes a Netlify site the first time (so the address is known), then uploads the pages. */
  const publish = async () => {
    setBusy('Getting an address…')
    try {
      let { siteId, siteUrl } = chain
      if (!siteId) {
        const site = (await api.invoke('netlifyCreate', { token, apiBase: netlifyApi() })) as { siteId: string; url: string }
        siteId = site.siteId
        siteUrl = site.url
        setChain((c) => ({ ...c, siteId, siteUrl }))
      }
      const live = { ...chain, siteId, siteUrl }
      setBusy('Building the puzzles…')
      const result = await buildChain(live, { loadCover })
      const zip = await buildZip(siteEntries(result.files))
      setBusy('Uploading…')
      await api.invoke('netlifyDeploy', { token, siteId, zip, apiBase: netlifyApi() })
      for (const w of result.warnings) toast.warn(w)
      const own = live.stages.filter(linked).length
      toast.ok('It is online', { detail: `Give out the note below.${own ? ` ${own} puzzle${own > 1 ? 's' : ''} live at your own links: "Export the files" writes those to an "elsewhere" folder for you to put online.` : ''}`, action: { label: 'Open', run: () => core.openExternal(siteUrl) } })
    } catch (err) {
      toast.error('Could not put it online', { detail: errorMessage(err) })
    } finally {
      setBusy(null)
    }
  }

  const takeDown = async () => {
    if (!chain.siteId) return
    setBusy('Taking it down…')
    try {
      await api.invoke('netlifyDelete', { token, siteId: chain.siteId, apiBase: netlifyApi() })
      setChain((c) => ({ ...c, siteId: '', siteUrl: '' }))
      toast.ok('It is gone', { detail: 'Put it online again whenever you like; it gets a new address.' })
    } catch (err) {
      toast.error('Could not take it down', { detail: errorMessage(err) })
    } finally {
      setBusy(null)
    }
  }

  const exportChain = async () => {
    const folder = await core.pickFolder({ title: 'Where should the files be written?' })
    if (!folder) return
    setBusy('Building…')
    try {
      const result = await buildChain(chain, { loadCover })
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
      const own = result.files.some((f) => f.path.startsWith('elsewhere/')) ? ' The "elsewhere" folder holds the files for your own links; read PUT THESE ONLINE.txt.' : ''
      toast.ok(`Files written: ${formatCount(result.files.length, 'file')} · ${formatBytes(bytes)}`, {
        detail: chain.mode === 'site' ? `The "site" folder is what goes online. Hand out START.txt only. The SOLUTION.txt next to the folder is for you.${own}` : `Hand out the whole "${safeName}" folder; START.txt is the way in. The SOLUTION.txt next to it is for you only.${own}`,
        action: { label: 'Show', run: () => core.reveal(root) },
      })
    } catch (err) {
      toast.error('Could not build the files', { detail: errorMessage(err) })
    } finally {
      setBusy(null)
    }
  }

  const zipIndex = chain.mode === 'files' ? chain.stages.findIndex((s) => s.kind === 'zip') : -1

  return (
    <div className="mm">
      <div className="mm__name">
        <input value={chain.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Name of the hunt" aria-label="Hunt name" />
      </div>

      <Panel title={<Step n={1}>Where it ends</Step>} hint="Paste an unlisted YouTube video: anyone with the link can watch it, nobody can find it. Any link works.">
        <Stack gap={8}>
          <TextInput value={chain.finale.url} onChange={(url) => patch({ finale: { ...chain.finale, url } })} mono placeholder="https://www.youtube.com/watch?v=…" />
          {youtubeId(chain.finale.url) ? <Badge tone="ok">YouTube video · it plays on the last page</Badge> : chain.finale.url.trim() ? <Badge tone="info">the last page links to it</Badge> : null}
        </Stack>
      </Panel>

      <Panel
        title={<Step n={2}>The puzzles</Step>}
        hint="Each puzzle hides the way to the next one. You never write the “go to…” parts yourself."
        actions={
          <Row gap={4}>
            {LEVELS.map((l) => (
              <Button key={l.level} size="sm" variant="ghost" icon={Wand2} title={l.blurb} onClick={() => useTemplate(l.level)}>
                {l.label}
              </Button>
            ))}
          </Row>
        }
        flush
      >
        <div className="mm__rows">
          {chain.stages.length === 0 && (
            <Empty icon={Puzzle} title="No puzzles yet">
              Pick Easy, Medium or Hard above, or add puzzles one by one below.
            </Empty>
          )}
          {chain.stages.map((s, i) => {
            const Icon = ICONS[s.kind]
            const isOpen = open === s.id
            return (
              <div key={s.id} className={cx('mm__row', isOpen && 'is-open', zipIndex >= 0 && i > zipIndex && 'is-inside')}>
                <div className="mm__row-head" role="button" tabIndex={0} onClick={() => setOpen(isOpen ? null : s.id)} onKeyDown={(e) => e.key === 'Enter' && setOpen(isOpen ? null : s.id)}>
                  {isOpen ? <ChevronDown size={14} className="mm__chev" /> : <ChevronRight size={14} className="mm__chev" />}
                  <span className="mm__num">{i + 1}</span>
                  <Icon size={15} />
                  <span className="mm__row-title">{s.title || kindLabel(s.kind)}</span>
                  <span className="mm__row-kind">
                    {kindLabel(s.kind)}
                    {linked(s) && ' · your own link'}
                  </span>
                  <span className="mm__row-tools" onClick={(e) => e.stopPropagation()}>
                    <IconButton icon={ArrowUp} label="Move up" disabled={i === 0} onClick={() => move(s.id, -1)} />
                    <IconButton icon={ArrowDown} label="Move down" disabled={i === chain.stages.length - 1} onClick={() => move(s.id, 1)} />
                    <IconButton icon={Trash2} label="Remove" onClick={() => remove(s.id)} />
                  </span>
                </div>
                {isOpen && <StageEditor chain={chain} stage={s} index={i} advanced={advanced} onChange={(p) => update(s.id, p)} />}
              </div>
            )
          })}
        </div>
        <div className="mm__add">
          {STAGE_KINDS.filter((k) => !k.siteOnly || chain.mode === 'site').map((k) => {
            const Icon = ICONS[k.kind]
            return (
              <button key={k.kind} type="button" className="mm__add-btn" onClick={() => add(k.kind)} title={k.blurb}>
                <Plus size={12} /> <Icon size={13} /> {k.label}
              </button>
            )
          })}
        </div>
      </Panel>

      <Panel title={<Step n={3}>{chain.mode === 'site' ? 'Put it online' : 'Make the folder'}</Step>} hint={chain.mode === 'site' ? 'The puzzles become hidden pages at addresses nobody can guess. You only give out the note.' : 'One folder with every puzzle locked behind the one before it.'}>
        <Stack gap={12}>
          {issues.length > 0 && (
            <Notice tone="warn" title={issues.length === 1 ? 'One thing to fix' : `${issues.length} things to fix`}>
              <ul className="mm__issues">
                {issues.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Notice>
          )}
          {chain.mode === 'files' ? (
            busy ? (
              <Progress value={null} label={busy} />
            ) : (
              <Button variant="primary" size="lg" icon={FolderOutput} disabled={!chain.stages.length} onClick={exportChain}>
                Make the folder…
              </Button>
            )
          ) : !connected ? (
            <div className="mm__connect">
              <div className="mm__connect-title">One-time setup: connect Netlify (free hosting)</div>
              <ol className="mm__connect-steps">
                <li>
                  <Button size="sm" icon={ExternalLink} onClick={() => core.openExternal(TOKEN_PAGE)}>
                    Open Netlify
                  </Button>
                  <span>log in or sign up, click <strong>New access token</strong>, copy it</span>
                </li>
                <li>
                  <TextInput value={draft} onChange={setDraft} mono type="password" placeholder="paste the token here" autoComplete="off" />
                  <Button size="sm" variant="primary" disabled={draft.trim().length < 20} onClick={() => { setToken(draft.trim()); setDraft('') }}>
                    Connect
                  </Button>
                </li>
              </ol>
            </div>
          ) : busy ? (
            <Progress value={null} label={busy} />
          ) : (
            <Row gap={8} wrap>
              <Button variant="primary" size="lg" icon={CloudUpload} disabled={!chain.stages.length} onClick={publish}>
                {online ? 'Update it online' : 'Put it online'}
              </Button>
              {online && (
                <Button variant="ghost" icon={Trash2} onClick={takeDown}>
                  Take it down
                </Button>
              )}
              <span className="mm__connected">
                Netlify connected ·{' '}
                <button type="button" className="mm__link" onClick={() => setToken('')}>
                  disconnect
                </button>
              </span>
            </Row>
          )}
          {online && (
            <div className="mm__give">
              <div className="mm__give-head">
                <span>Give them this note. Nothing else.</span>
                <CopyButton text={startNote(chain)} label="Copy the note" />
              </div>
              <pre className="mm__give-note">{startNote(chain).trim()}</pre>
              <div className="mm__live">
                <span className="mm__live-dot" />
                <span className="mm__live-url">{chain.siteUrl}</span>
                <IconButton icon={ExternalLink} label="Open the site" onClick={() => core.openExternal(chain.siteUrl)} />
              </div>
            </div>
          )}
        </Stack>
      </Panel>

      <details className="mm__more">
        <summary>For you: how every puzzle is solved</summary>
        <Walkthrough chain={chain} />
      </details>

      <details className="mm__more">
        <summary>More options</summary>
        <Stack gap={14}>
          <Field label="Opening words of the note">
            <TextArea value={chain.intro} onChange={(intro) => patch({ intro })} rows={2} mono={false} />
          </Field>
          <Field label="Words on the last page">
            <TextArea value={chain.finale.message} onChange={(message) => patch({ finale: { ...chain.finale, message } })} rows={2} mono={false} />
          </Field>
          <Field label="Skip the last page, send them straight to the link" inline>
            <Toggle checked={chain.finale.direct} onChange={(direct) => patch({ finale: { ...chain.finale, direct } })} disabled={!chain.finale.url.trim()} />
          </Field>
          <Field label="Where the hunt lives" hint={chain.mode === 'site' ? 'Online: hidden pages, nobody can skip ahead.' : 'A folder of files you hand out. Locked so nobody can skip ahead, but it is all in their hands.'}>
            <Segmented<HuntMode>
              size="sm"
              value={chain.mode}
              onChange={setMode}
              options={[
                { value: 'site', label: 'Online', icon: Globe },
                { value: 'files', label: 'A folder of files', icon: Folder },
              ]}
            />
          </Field>
          {chain.mode === 'files' && (
            <Field label="Lock every puzzle behind the one before it" inline>
              <Toggle checked={chain.lockAll} onChange={(lockAll) => patch({ lockAll })} />
            </Field>
          )}
          {chain.mode === 'site' && (
            <Row gap={8} wrap>
              <Button icon={FolderOutput} disabled={!chain.stages.length || !!busy} onClick={exportChain}>
                Export the files…
              </Button>
              <span className="mm__hint">The note, the pages (to host yourself) and anything for your own links.</span>
            </Row>
          )}
          {chain.mode === 'site' && (
            <Field label="Hosting it yourself instead? The address the pages will live at" hint="Filled in for you when you put it online.">
              <TextInput value={chain.siteUrl} onChange={(siteUrl) => patch({ siteUrl, siteId: '' })} mono placeholder="https://something.netlify.app" />
            </Field>
          )}
          <Field label="Advanced controls" inline hint="Passwords and keywords, page addresses, cipher choice, hints, and putting a puzzle at a link of your own (a video description, a pastebin…).">
            <Toggle checked={advanced} onChange={setAdvanced} />
          </Field>
          {chain.stages.length > 0 && (
            <Button variant="ghost" icon={Trash2} onClick={() => { setChain((c) => ({ ...emptyChain(), name: c.name, mode: c.mode, siteUrl: c.siteUrl, siteId: c.siteId })); setOpen(null) }}>
              Remove every puzzle
            </Button>
          )}
        </Stack>
      </details>
    </div>
  )
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <span className="mm__stepno">
      <span className="mm__num">{n}</span>
      {children}
    </span>
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

function StageEditor({ chain, stage, index, advanced, onChange }: { chain: Chain; stage: Stage; index: number; advanced: boolean; onChange: (p: Partial<Stage>) => void }) {
  const kind = STAGE_KINDS.find((k) => k.kind === stage.kind)!
  const next = chain.stages[index + 1] as Stage | undefined
  const afterAudio = index > 0 && chain.stages[index - 1].kind === 'audio'
  const hidden = messageOf(chain, index)
  const isAudio = stage.kind === 'audio'
  const own = linked(stage)
  const locked = lockedAt(chain, index)
  return (
    <div className="mm__row-editor">
      <p className="mm__hint">{kind.blurb}</p>
      <Row gap={12} wrap>
        <Field label="Title">
          <TextInput value={stage.title} onChange={(title) => onChange({ title })} placeholder={kind.label} />
        </Field>
        {advanced && (needsWord(stage) || locked) && (
          <Field label={stage.kind === 'cipher' && needsWord(stage) ? (locked ? 'Keyword and zip password' : 'Keyword') : 'Password'} hint={index === 0 ? 'the note tells the player this' : afterAudio ? 'the sound before spells this' : `puzzle ${index} tells the player this`}>
            <WordInput value={stage.word} onChange={(word) => onChange({ word })} />
          </Field>
        )}
      </Row>
      {!isAudio && (
        <Field label="A line of story (optional)" hint="What they read once they crack it; the way to the next puzzle is added underneath by itself.">
          <TextArea value={stage.story} onChange={(story) => onChange({ story })} rows={2} mono={false} placeholder={stage.kind === 'cipher' && stage.cipher === 'invisible' ? 'The innocent sentence the secret hides inside' : 'One or two lines…'} />
        </Field>
      )}
      {stage.kind === 'image' && (
        <Field label="Your own photo (optional)" hint="Leave empty and a grainy night-camera frame is made for you. The output is always a PNG.">
          {stage.coverPath ? <PathChip path={stage.coverPath} icon={ImageIcon} onClear={() => onChange({ coverPath: null })} /> : <Dropzone compact title="Drop a picture" hint="or browse" icon={ImageIcon} filters={[{ name: 'Picture', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]} strict onPaths={(p) => onChange({ coverPath: p[0] })} />}
        </Field>
      )}
      {isAudio && (
        <Notice tone="info" icon={AudioLines}>
          {next ? (
            <>
              The sound spells <strong>{pointer(chain, index)}</strong>: {needsWord(next) || lockedAt(chain, index + 1) ? `the password of puzzle ${index + 2}` : chain.mode === 'site' ? `puzzle ${index + 2} lives at /${pointer(chain, index).toLowerCase()}/` : `puzzle ${index + 2} is the file called ${whereIs(chain, index + 1)}`}.
            </>
          ) : (
            <>The sound spells <strong>{pointer(chain, index)}</strong>, which leads to the ending.</>
          )}
        </Notice>
      )}

      {advanced && (
        <Stack gap={12}>
          {stage.kind === 'cipher' && (
            <Field label="Cipher" hint={CIPHERS.find((c) => c.value === stage.cipher)!.blurb}>
              <Select<CipherPreset> value={stage.cipher} onChange={(cipher) => onChange({ cipher })} options={CIPHERS.map((c) => ({ value: c.value, label: c.label }))} />
            </Field>
          )}
          {stage.kind === 'image' && (
            <Field label="Where to hide it in the picture">
              <Segmented<'lsb' | 'text' | 'both'> block size="sm" value={stage.imageMethod} onChange={(imageMethod) => onChange({ imageMethod })} options={[{ value: 'lsb', label: 'In the pixels (hard)' }, { value: 'text', label: 'In the metadata (easy)' }, { value: 'both', label: 'Both' }]} />
            </Field>
          )}
          {stage.kind === 'folder' && (
            <Field label="Junk files" hint="The real note is in the deepest folder.">
              <NumberInput value={stage.decoys} onChange={(decoys) => onChange({ decoys })} min={5} max={400} width={100} />
            </Field>
          )}
          {stage.kind !== 'gate' && (
            <Field label="Where it lives">
              <Segmented<Where> block size="sm" value={stage.where} onChange={(where) => onChange({ where })} options={[{ value: 'auto', label: chain.mode === 'site' ? 'On the hunt site' : 'In the folder', icon: chain.mode === 'site' ? Globe : Folder }, { value: 'link', label: 'At a link of my own', icon: Link2 }]} />
            </Field>
          )}
          {own ? (
            <Stack gap={8}>
              <Field label="The link" hint="Make the place first (an unlisted video, a pastebin, a Google Doc, a Discord message, an image host…), paste its link here, then put the clue there.">
                <TextInput value={stage.link} onChange={(link) => onChange({ link })} mono placeholder="https://…" />
              </Field>
              <Notice tone="info" icon={Link2}>
                {index === 0 ? 'The note' : `Puzzle ${index}`} will send the player to this link. You put the clue there yourself: {placementOf(chain, index)}.{stage.kind === 'cipher' ? ' The text to paste is below.' : ' “Export the files” writes it into an “elsewhere” folder.'}
              </Notice>
            </Stack>
          ) : (
            chain.mode === 'site' &&
            !afterAudio && (
              <Field label="Page address" hint={`${chain.siteUrl.replace(/\/+$/, '') || '<your site>'}/${stage.slug}/ — random, so nobody can guess their way to it`}>
                <Row gap={6}>
                  <TextInput value={stage.slug} onChange={(slug) => onChange({ slug: slug.replace(/[^a-z0-9-]/gi, '').toLowerCase() })} mono />
                  <IconButton icon={Shuffle} label="New random address" onClick={() => onChange({ slug: randomSlug() })} />
                </Row>
              </Field>
            )
          )}
          <Field label="Leave a small hint" inline hint={stage.kind === 'cipher' ? 'a bracketed nudge under the cipher text' : 'a faint line on the page'}>
            <Toggle checked={stage.hint} onChange={(hint) => onChange({ hint })} />
          </Field>
          <div className="mm__reveal">
            <div className="mm__label">{isAudio ? 'What the spectrogram shows' : 'What this puzzle hides'}</div>
            {isAudio ? <AudioPreview text={hidden} /> : stage.kind === 'qr' ? <QrPreview text={hidden} /> : stage.kind === 'cipher' ? <CipherPreview stage={stage} message={hidden} /> : null}
            {!isAudio && <TextArea value={hidden} readOnly rows={Math.min(6, hidden.split('\n').length + 1)} />}
            <p className="mm__hint">
              <strong>How they get it:</strong> {locked ? `extract "${whereIs(chain, index)}" with the password "${stage.word}", then ` : ''}
              {howSolved(stage)}
            </p>
          </div>
        </Stack>
      )}
      {!advanced && own && stage.kind === 'cipher' && <CipherPreview stage={stage} message={hidden} />}
      {!advanced && isAudio && <AudioPreview text={hidden} />}
    </div>
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
    <Field label={<Row gap={8}>What the player sees <CopyButton text={encoded} label="Copy the cipher text" /></Row>}>
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
    <Field label={`How it looks in Audacity’s spectrogram view${seconds ? ` (${seconds.toFixed(1)} s)` : ''}`} hint="To the ear it is just eerie tones.">
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
