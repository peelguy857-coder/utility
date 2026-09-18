import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Image as ImageIcon, LayoutGrid, ListVideo, Moon, PanelRight, Smartphone, Sun, X } from 'lucide-react'
import { core, errorMessage } from '@/lib/bridge'
import { baseName, cx, extOf, formatBytes } from '@/lib/format'
import { useToast } from '@/components/Toasts'
import { Dropzone } from '@/components/Dropzone'
import { Badge, Checkbox, Field, IconButton, Panel, Segmented, Stack, TextInput, Workbench } from '@/components/ui'
import './ui.css'

type View = 'home' | 'search' | 'sidebar' | 'phone'
type Tone = 'dark' | 'light'

interface Thumb {
  id: string
  path: string
  url: string
  width: number
  height: number
  bytes: number
  ext: string
}

interface Check {
  ok: boolean
  text: string
}

const FILTERS = [{ name: 'Thumbnail', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
// neutral stand-ins so your thumbnail sits among "other videos", the way it does on YouTube
interface Filler {
  title: string
  channel: string
  meta: string
  hue: number
  dur: string
  empty?: boolean
}

const FILLERS: Filler[] = [
  { title: 'I Built a Working Computer in Minecraft', channel: 'BlockWorks', meta: '1.2M views · 3 days ago', hue: 210, dur: '18:42' },
  { title: 'We Survived 100 Days on a Raft', channel: 'Raft Bros', meta: '486K views · 1 week ago', hue: 28, dur: '24:10' },
  { title: 'Ranking Every Biome (Tier List)', channel: 'PixelPeak', meta: '92K views · 12 hours ago', hue: 140, dur: '11:05' },
  { title: 'The Hardest Speedrun Category Explained', channel: 'runtime', meta: '2.1M views · 2 months ago', hue: 280, dur: '32:51' },
  { title: 'This Update Changes Everything', channel: 'Daily Craft', meta: '310K views · 5 days ago', hue: 330, dur: '9:58' },
  { title: 'Base Tour: 3 Years of Building', channel: 'Stone & Sky', meta: '58K views · 1 day ago', hue: 60, dur: '41:20' },
]

function checks(t: Thumb): Check[] {
  const ratio = t.width / t.height
  return [
    { ok: t.width >= 1280 && t.height >= 720, text: t.width >= 1280 && t.height >= 720 ? `${t.width}×${t.height} — sharp everywhere` : `${t.width}×${t.height} — YouTube wants at least 1280×720; this will look soft on TVs` },
    { ok: Math.abs(ratio - 16 / 9) < 0.02, text: Math.abs(ratio - 16 / 9) < 0.02 ? '16:9, fills the frame' : `Not 16:9 (${ratio.toFixed(2)}:1) — YouTube adds black bars or crops` },
    { ok: t.bytes <= 2 * 1024 * 1024, text: t.bytes <= 2 * 1024 * 1024 ? `${formatBytes(t.bytes)} — under the 2 MB limit` : `${formatBytes(t.bytes)} — over YouTube's 2 MB limit (Image Lab can shrink it)` },
    { ok: ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(t.ext), text: ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(t.ext) ? `${t.ext.toUpperCase()} is accepted` : `${t.ext.toUpperCase()} is not an upload format` },
  ]
}

function Card({ thumb, title, channel, meta, dur, safe, layout, hue, empty }: { thumb?: Thumb; title: string; channel: string; meta: string; dur: string; safe: boolean; layout: 'grid' | 'row' | 'mini' | 'phone'; hue?: number; empty?: boolean }) {
  return (
    <div className={cx('yt-card', `yt-card--${layout}`)}>
      <div className={cx('yt-thumb', !thumb && 'yt-thumb--filler', empty && 'yt-thumb--empty')} style={!thumb && hue != null ? { ['--fh' as string]: hue } : undefined}>
        {thumb ? <img src={thumb.url} alt="" draggable={false} /> : <span>{empty ? 'your thumbnail goes here' : 'other video'}</span>}
        <span className="yt-dur">{dur}</span>
        {safe && thumb && (
          <>
            <span className="yt-safe" />
            <span className="yt-progress" />
          </>
        )}
      </div>
      <div className="yt-text">
        {layout !== 'mini' && (
          <span className="yt-avatar" style={{ ['--fh' as string]: hue ?? 5 }}>
            {channel.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="yt-lines">
          <div className="yt-title">{title || 'Untitled video'}</div>
          <div className="yt-meta">{channel}</div>
          <div className="yt-meta">{meta}</div>
        </div>
      </div>
    </div>
  )
}

export default function ThumbTester() {
  const toast = useToast()
  const [thumbs, setThumbs] = useState<Thumb[]>([])
  const [title, setTitle] = useState('I Survived 100 Days in Hardcore Minecraft (Ep. 1)')
  const [channel, setChannel] = useState('Isaac')
  const [meta, setMeta] = useState('24K views · 2 hours ago')
  const [dur, setDur] = useState('16:47')
  const [view, setView] = useState<View>('home')
  const [tone, setTone] = useState<Tone>('dark')
  const [safe, setSafe] = useState(false)
  const urls = useRef<string[]>([])

  useEffect(() => {
    return () => {
      for (const u of urls.current) URL.revokeObjectURL(u)
    }
  }, [])

  const add = async (paths: string[]) => {
    for (const p of paths) {
      if (thumbs.some((t) => t.path === p)) continue
      try {
        const bytes = await core.readFile(p)
        const blob = new Blob([bytes as BlobPart])
        const bmp = await createImageBitmap(blob)
        const url = URL.createObjectURL(blob)
        urls.current.push(url)
        const thumb: Thumb = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, path: p, url, width: bmp.width, height: bmp.height, bytes: bytes.byteLength, ext: extOf(p) }
        bmp.close()
        setThumbs((list) => [...list, thumb].slice(0, 4))
      } catch (err) {
        toast.error(`Could not open ${baseName(p)}`, { detail: errorMessage(err) })
      }
    }
  }

  const remove = (id: string) => setThumbs((list) => list.filter((t) => t.id !== id))

  // the user's thumbnails, each in its own card, mixed with fillers so the feed looks real
  const feed = useMemo(() => {
    const slots: Array<{ thumb?: Thumb; filler?: Filler }> = []
    const mine: Array<Thumb | undefined> = thumbs.length ? thumbs : [undefined]
    let f = 0
    mine.forEach((t, i) => {
      if (i === 0) slots.push({ filler: FILLERS[f++] })
      // no thumbnail yet: an empty slot that says where yours will go
      slots.push(t ? { thumb: t } : { filler: { title: title || 'Your video', channel, meta, dur, hue: 5, empty: true } })
      slots.push({ filler: FILLERS[f++ % FILLERS.length] })
      if (i === 0) slots.push({ filler: FILLERS[f++ % FILLERS.length] })
    })
    return slots.slice(0, 8)
  }, [thumbs, title, channel, meta, dur])

  const card = (slot: { thumb?: Thumb; filler?: Filler }, layout: 'grid' | 'row' | 'mini' | 'phone', key: number) =>
    slot.thumb ? (
      <Card key={key} thumb={slot.thumb} title={title} channel={channel} meta={meta} dur={dur} safe={safe} layout={layout} />
    ) : (
      <Card key={key} title={slot.filler!.title} channel={slot.filler!.channel} meta={slot.filler!.meta} dur={slot.filler!.dur} safe={false} layout={layout} hue={slot.filler!.hue} empty={slot.filler!.empty} />
    )

  return (
    <Workbench
      sideWidth={320}
      side={
        <>
          <Panel title="Video">
            <Stack gap={12}>
              <Field label="Title">
                <TextInput value={title} onChange={setTitle} placeholder="Your video title" />
              </Field>
              <Field label="Channel">
                <TextInput value={channel} onChange={setChannel} />
              </Field>
              <Field label="Views · when">
                <TextInput value={meta} onChange={setMeta} />
              </Field>
              <Field label="Length">
                <TextInput value={dur} onChange={setDur} placeholder="12:34" />
              </Field>
            </Stack>
          </Panel>
          <Panel title="Thumbnails" hint="Drop up to four to compare versions side by side.">
            <Stack gap={8}>
              {thumbs.map((t) => {
                const bad = checks(t).filter((c) => !c.ok)
                return (
                  <div key={t.id} className="tt-item">
                    <img src={t.url} alt="" />
                    <div className="tt-item__text">
                      <div className="tt-item__name">{baseName(t.path)}</div>
                      <div className="tt-item__meta">
                        {t.width}×{t.height} · {formatBytes(t.bytes)}
                      </div>
                    </div>
                    {bad.length ? <Badge tone="warn">{bad.length}</Badge> : <Badge tone="ok">ok</Badge>}
                    <IconButton icon={X} label="Remove" onClick={() => remove(t.id)} />
                  </div>
                )
              })}
              <Dropzone compact multiple title={thumbs.length ? 'Add another version' : 'Drop a thumbnail'} hint="PNG, JPG or WebP · 1280×720" icon={ImageIcon} filters={FILTERS} strict onPaths={add} />
            </Stack>
          </Panel>
          {thumbs.length > 0 && (
            <Panel title="Checks">
              <Stack gap={10}>
                {thumbs.map((t) => (
                  <div key={t.id} className="tt-checks">
                    {thumbs.length > 1 && <div className="tt-checks__name">{baseName(t.path)}</div>}
                    {checks(t).map((c) => (
                      <div key={c.text} className={cx('tt-check', c.ok ? 'is-ok' : 'is-bad')}>
                        {c.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                        <span>{c.text}</span>
                      </div>
                    ))}
                  </div>
                ))}
                <Checkbox checked={safe} onChange={setSafe}>
                  Show what the length badge and progress bar cover
                </Checkbox>
              </Stack>
            </Panel>
          )}
        </>
      }
    >
      <div className="tt-toolbar">
        <Segmented<View>
          value={view}
          onChange={setView}
          options={[
            { value: 'home', label: 'Home', icon: LayoutGrid },
            { value: 'search', label: 'Search', icon: ListVideo },
            { value: 'sidebar', label: 'Up next', icon: PanelRight },
            { value: 'phone', label: 'Phone', icon: Smartphone },
          ]}
        />
        <Segmented<Tone>
          size="sm"
          value={tone}
          onChange={setTone}
          options={[
            { value: 'dark', label: 'Dark', icon: Moon },
            { value: 'light', label: 'Light', icon: Sun },
          ]}
        />
      </div>

      <div className={cx('yt', `yt--${tone}`, `yt--${view}`)}>
        {view === 'home' && <div className="yt-grid">{feed.map((slot, i) => card(slot, 'grid', i))}</div>}
        {view === 'search' && <div className="yt-list">{feed.slice(0, 5).map((slot, i) => card(slot, 'row', i))}</div>}
        {view === 'sidebar' && (
          <div className="yt-side">
            <div className="yt-player">
              <span>video playing</span>
            </div>
            <div className="yt-side__list">{feed.map((slot, i) => card(slot, 'mini', i))}</div>
          </div>
        )}
        {view === 'phone' && (
          <div className="yt-phone">
            <div className="yt-phone__bar" />
            {feed.slice(0, 4).map((slot, i) => card(slot, 'phone', i))}
          </div>
        )}
      </div>

      {thumbs.length > 0 && (
        <Panel title="At a glance" hint="How it reads when it is tiny — the size most people first see it at.">
          <div className="tt-small">
            {thumbs.map((t) => (
              <div key={t.id} className="tt-small__item">
                <img src={t.url} alt="" style={{ width: 120 }} />
                <img src={t.url} alt="" style={{ width: 80 }} />
                <img src={t.url} alt="" style={{ width: 48 }} />
              </div>
            ))}
          </div>
        </Panel>
      )}
    </Workbench>
  )
}
