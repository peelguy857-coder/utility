import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, FolderOutput, Image as ImageIcon, Info, X } from 'lucide-react'
import { core, errorMessage } from '@/lib/bridge'
import { baseName, cx, extOf, formatBytes, formatCount } from '@/lib/format'
import { useToast } from '@/components/Toasts'
import { Dropzone } from '@/components/Dropzone'
import { Badge, Button, IconButton, Notice, Panel, Progress, Row, Stack } from '@/components/ui'
import './ui.css'

interface Slot {
  id: string
  name: string
  w: number
  h: number
  where: string
  png?: boolean
  alpha?: boolean
  multi?: boolean
  min?: number
}

// Steamworks "Graphical Assets" requirements (2024 layout)
const SLOTS: Slot[] = [
  { id: 'header', name: 'Header capsule', w: 920, h: 430, where: 'Top of the store page, search, recommendations' },
  { id: 'small', name: 'Small capsule', w: 462, h: 174, where: 'Lists, search results, "more like this"' },
  { id: 'main', name: 'Main capsule', w: 1232, h: 706, where: 'Front-page features and Daily Deals' },
  { id: 'vertical', name: 'Vertical capsule', w: 748, h: 896, where: 'Sales, curator lists' },
  { id: 'library', name: 'Library capsule', w: 600, h: 900, where: 'The Steam library grid' },
  { id: 'hero', name: 'Library hero', w: 3840, h: 1240, where: 'Banner at the top of the library page' },
  { id: 'logo', name: 'Library logo', w: 1280, h: 720, where: 'Drawn over the hero — transparent PNG', png: true, alpha: true },
  { id: 'background', name: 'Page background', w: 1438, h: 810, where: 'Behind the store page (blurred)' },
  { id: 'icon', name: 'Community icon', w: 184, h: 184, where: 'Community hub, forums' },
  { id: 'screenshot', name: 'Screenshots', w: 1920, h: 1080, where: 'At least 5, no marketing text', multi: true, min: 5 },
]

interface Art {
  path: string
  url: string
  bitmap: ImageBitmap
  bytes: number
  ext: string
}

type Fit = 'exact' | 'crop' | 'small' | 'both'

function fitOf(slot: Slot, art: Art): { fit: Fit; text: string } {
  const ratioOk = Math.abs(art.bitmap.width / art.bitmap.height - slot.w / slot.h) < 0.01
  const bigEnough = art.bitmap.width >= slot.w && art.bitmap.height >= slot.h
  if (art.bitmap.width === slot.w && art.bitmap.height === slot.h) return { fit: 'exact', text: 'Exact size' }
  if (ratioOk && bigEnough) return { fit: 'exact', text: `Right shape, will be scaled from ${art.bitmap.width}×${art.bitmap.height}` }
  if (!ratioOk && bigEnough) return { fit: 'crop', text: `Will be cropped to ${slot.w}:${slot.h} from the centre` }
  if (ratioOk) return { fit: 'small', text: `Only ${art.bitmap.width}×${art.bitmap.height} — will look soft` }
  return { fit: 'both', text: `Small (${art.bitmap.width}×${art.bitmap.height}) and the wrong shape` }
}

/** Centre-crop `art` into a slot-sized canvas. */
function render(slot: Slot, art: Art): OffscreenCanvas {
  const canvas = new OffscreenCanvas(slot.w, slot.h)
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  const scale = Math.max(slot.w / art.bitmap.width, slot.h / art.bitmap.height)
  const w = art.bitmap.width * scale
  const h = art.bitmap.height * scale
  if (slot.alpha) ctx.clearRect(0, 0, slot.w, slot.h)
  ctx.drawImage(art.bitmap, (slot.w - w) / 2, (slot.h - h) / 2, w, h)
  return canvas
}

export default function SteamAssets() {
  const toast = useToast()
  const [arts, setArts] = useState<Record<string, Art[]>>({})
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null)
  const [name, setName] = useState('')
  const previews = useRef<Record<string, HTMLCanvasElement | null>>({})

  useEffect(() => {
    // small previews of what will really be exported (cropped, scaled)
    for (const slot of SLOTS) {
      const canvas = previews.current[slot.id]
      const art = arts[slot.id]?.[0]
      if (!canvas) continue
      const ctx = canvas.getContext('2d')!
      const scale = Math.min(1, 300 / slot.w, 180 / slot.h)
      canvas.width = Math.round(slot.w * scale)
      canvas.height = Math.round(slot.h * scale)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (art) {
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(render(slot, art), 0, 0, canvas.width, canvas.height)
      }
    }
  }, [arts])

  const load = async (slotId: string, paths: string[]) => {
    const slot = SLOTS.find((s) => s.id === slotId)!
    const loaded: Art[] = []
    for (const p of paths) {
      try {
        const bytes = await core.readFile(p)
        const blob = new Blob([bytes as BlobPart])
        const bitmap = await createImageBitmap(blob)
        loaded.push({ path: p, url: URL.createObjectURL(blob), bitmap, bytes: bytes.byteLength, ext: extOf(p) })
      } catch (err) {
        toast.error(`Could not open ${baseName(p)}`, { detail: errorMessage(err) })
      }
    }
    if (!loaded.length) return
    if (!name) setName(baseName(paths[0]).replace(/\.[^.]+$/, '').replace(/[-_ ]?(header|capsule|hero|logo|icon|screenshot)\d*$/i, '') || 'game')
    setArts((a) => ({ ...a, [slotId]: slot.multi ? [...(a[slotId] || []), ...loaded] : loaded.slice(0, 1) }))
  }

  const clear = (slotId: string, index?: number) => setArts((a) => ({ ...a, [slotId]: index == null ? [] : (a[slotId] || []).filter((_, i) => i !== index) }))

  const exportAll = async () => {
    const jobs: Array<{ slot: Slot; art: Art; file: string }> = []
    for (const slot of SLOTS) (arts[slot.id] || []).forEach((art, i) => jobs.push({ slot, art, file: slot.multi ? `${slot.id}-${String(i + 1).padStart(2, '0')}` : slot.id }))
    if (!jobs.length) return
    const folder = await core.pickFolder({ title: 'Where should the Steam files go?' })
    if (!folder) return
    const outDir = `${folder}\\${(name || 'game').replace(/[\\/:*?"<>|]+/g, '-')}-steam`
    setBusy({ done: 0, total: jobs.length })
    try {
      let bytes = 0
      for (const [i, job] of jobs.entries()) {
        const canvas = render(job.slot, job.art)
        const png = job.slot.png || job.slot.alpha
        const blob = await canvas.convertToBlob(png ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.92 })
        const data = new Uint8Array(await blob.arrayBuffer())
        await core.writeFile(`${outDir}\\${job.file}.${png ? 'png' : 'jpg'}`, data)
        bytes += data.length
        setBusy({ done: i + 1, total: jobs.length })
      }
      toast.ok(`Wrote ${formatCount(jobs.length, 'file')}`, { detail: `${formatBytes(bytes)} in ${outDir}`, action: { label: 'Show', run: () => core.reveal(outDir) } })
    } catch (err) {
      toast.error('Export failed', { detail: errorMessage(err) })
    } finally {
      setBusy(null)
    }
  }

  const filled = SLOTS.filter((s) => (arts[s.id] || []).length > 0)
  const shots = arts.screenshot?.length ?? 0

  return (
    <Stack gap={16}>
      <Notice tone="info" icon={Info}>
        Sizes follow Steamworks’ graphical-asset rules. Drop the same big artwork on several slots — each one is cropped from the centre to its exact size. Capsules must be readable at small sizes and carry the game’s name; screenshots must not.
      </Notice>

      <div className="steam__grid">
        {SLOTS.map((slot) => {
          const list = arts[slot.id] || []
          const first = list[0]
          const fit = first ? fitOf(slot, first) : null
          return (
            <Panel key={slot.id} flush className="steam__slot">
              <div className="steam__head">
                <div>
                  <div className="steam__name">
                    {slot.name} <span className="steam__size">{slot.w}×{slot.h}</span>
                  </div>
                  <div className="steam__where">{slot.where}</div>
                </div>
                {first && !slot.multi && <IconButton icon={X} label="Clear" onClick={() => clear(slot.id)} />}
              </div>
              <div className={cx('steam__preview', slot.alpha && 'is-checker')} style={{ aspectRatio: `${slot.w} / ${slot.h}` }}>
                {first ? <canvas ref={(el) => void (previews.current[slot.id] = el)} /> : <span className="steam__empty">{slot.multi ? `${shots} of ${slot.min} screenshots` : 'empty'}</span>}
              </div>
              {slot.multi && list.length > 0 && (
                <div className="steam__shots">
                  {list.map((a, i) => (
                    <button key={a.path + i} type="button" className="steam__shot" title={`Remove ${baseName(a.path)}`} onClick={() => clear(slot.id, i)}>
                      <img src={a.url} alt="" />
                    </button>
                  ))}
                </div>
              )}
              <div className="steam__foot">
                {fit ? (
                  <span className={cx('steam__fit', fit.fit === 'exact' ? 'is-ok' : 'is-warn')}>
                    {fit.fit === 'exact' ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />} {fit.text}
                  </span>
                ) : (
                  <span className="steam__fit">{slot.alpha ? 'PNG with transparency' : 'JPG or PNG'}</span>
                )}
                <Dropzone compact multiple={!!slot.multi} title={first ? 'Replace' : 'Drop or browse'} icon={ImageIcon} filters={[{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]} strict onPaths={(p) => load(slot.id, p)} />
              </div>
            </Panel>
          )
        })}
      </div>

      <Panel>
        <Row justify="space-between" wrap>
          <div>
            <strong>{formatCount(filled.length, 'slot')} filled</strong>
            <span className="steam__note">
              {' '}
              of {SLOTS.length}
              {shots < 5 && ` · screenshots: ${shots}/5`}
            </span>
          </div>
          <Row gap={8}>
            {filled.length > 0 && filled.length < SLOTS.length && <Badge tone="warn">{SLOTS.length - filled.length} missing</Badge>}
            <Button variant="primary" size="lg" icon={FolderOutput} disabled={filled.length === 0 || !!busy} loading={!!busy} onClick={exportAll}>
              Export exact sizes…
            </Button>
          </Row>
        </Row>
        {busy && (
          <div style={{ marginTop: 12 }}>
            <Progress value={busy.done / busy.total} label="Rendering" />
          </div>
        )}
      </Panel>
    </Stack>
  )
}
