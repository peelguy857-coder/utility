import { useEffect, useMemo, useRef, useState } from 'react'
import { Circle, FolderOutput, Image as ImageIcon, Square, SquareDashed } from 'lucide-react'
import { core, errorMessage } from '@/lib/bridge'
import { baseName, cx, extOf, formatBytes, formatCount, stripExt } from '@/lib/format'
import { useToast } from '@/components/Toasts'
import { Dropzone, PathChip } from '@/components/Dropzone'
import { Button, Checkbox, Field, Panel, Progress, Segmented, Slider, Stack, TextInput, Toggle, Workbench } from '@/components/ui'
import { loadBitmap, MASTER, renderMaster, type Shape } from './lib/render'
import { buildOutputs, PACKS, type PackId } from './lib/packs'
import './ui.css'

const FILTERS = [{ name: 'Images', extensions: ['png', 'svg', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif'] }]
const STRIP = [128, 64, 48, 32, 16]
type Backdrop = 'checker' | 'dark' | 'light'

interface Saved {
  packs: PackId[]
  shape: Shape
  padding: number
}

function AppleIcon({ size = 14 }: { size?: number }) {
  // lucide's Apple glyph is a fruit, which reads wrong here; a rounded tile says "macOS icon" better
  return <Square size={size} strokeWidth={2.4} style={{ borderRadius: 4 }} />
}

export default function IconForge() {
  const toast = useToast()
  const [path, setPath] = useState<string | null>(null)
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null)
  const [shape, setShape] = useState<Shape>('none')
  const [padding, setPadding] = useState(0)
  const [useBackground, setUseBackground] = useState(false)
  const [background, setBackground] = useState('#1b1e27')
  const [fit, setFit] = useState<'contain' | 'cover'>('contain')
  const [packs, setPacks] = useState<PackId[]>(['ico', 'icns', 'png'])
  const [name, setName] = useState('icon')
  const [backdrop, setBackdrop] = useState<Backdrop>('checker')
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null)
  const stageRef = useRef<HTMLCanvasElement>(null)
  const stripRefs = useRef<Record<number, HTMLCanvasElement | null>>({})

  useEffect(() => {
    core.getUtilSettings<Saved>('icon-forge').then((s) => {
      if (s.packs?.length) setPacks(s.packs)
      if (s.shape) setShape(s.shape)
      if (typeof s.padding === 'number') setPadding(s.padding)
    })
  }, [])
  useEffect(() => {
    core.setUtilSettings<Saved>('icon-forge', { packs, shape, padding })
  }, [packs, shape, padding])

  // macOS tiles always need a fill colour; suggest white-ish until the user picks one
  const effectiveBackground = useBackground || shape === 'macos' ? background : null

  const master = useMemo(
    () => (bitmap ? renderMaster(bitmap, { shape, padding, background: effectiveBackground, fit }) : null),
    [bitmap, shape, padding, effectiveBackground, fit],
  )

  useEffect(() => {
    if (!master) return
    const stage = stageRef.current
    if (stage) {
      stage.width = MASTER
      stage.height = MASTER
      const ctx = stage.getContext('2d')!
      ctx.clearRect(0, 0, MASTER, MASTER)
      ctx.drawImage(master, 0, 0)
    }
    for (const size of STRIP) {
      const canvas = stripRefs.current[size]
      if (!canvas) continue
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')!
      ctx.imageSmoothingQuality = 'high'
      ctx.clearRect(0, 0, size, size)
      ctx.drawImage(master, 0, 0, size, size)
    }
  }, [master])

  const load = async (p: string) => {
    try {
      const bytes = await core.readFile(p)
      const bmp = await loadBitmap(bytes, extOf(p))
      setBitmap(bmp)
      setPath(p)
      setName(stripExt(baseName(p)).replace(/[^\w.-]+/g, '-').toLowerCase() || 'icon')
      if (Math.min(bmp.width, bmp.height) < 512) toast.warn('Small source image', { detail: `${bmp.width}×${bmp.height} — the large sizes will look soft. 1024×1024 or an SVG is ideal.` })
    } catch (err) {
      toast.error('Could not open that image', { detail: errorMessage(err) })
    }
  }

  const exportAll = async () => {
    if (!master || packs.length === 0) return
    const folder = await core.pickFolder({ title: 'Where should the icons go?' })
    if (!folder) return
    const safe = name.trim().replace(/[\\/:*?"<>|]+/g, '-') || 'icon'
    const outDir = `${folder}\\${safe}-icons`
    try {
      setBusy({ done: 0, total: packs.length })
      const files = await buildOutputs(master, packs, safe, effectiveBackground ?? '#ffffff', (done, total) => setBusy({ done, total }))
      let bytes = 0
      for (const file of files) {
        await core.writeFile(`${outDir}\\${file.path.replaceAll('/', '\\')}`, file.bytes)
        bytes += file.bytes.length
      }
      toast.ok(`Wrote ${formatCount(files.length, 'file')}`, { detail: `${formatBytes(bytes)} in ${outDir}`, action: { label: 'Show', run: () => core.reveal(outDir) } })
    } catch (err) {
      toast.error('Export failed', { detail: errorMessage(err) })
    } finally {
      setBusy(null)
    }
  }

  const togglePack = (id: PackId, on: boolean) => setPacks((list) => (on ? [...list, id] : list.filter((p) => p !== id)))

  return (
    <Workbench
      sideWidth={340}
      side={
        <>
          <Panel title="Shape">
            <Stack gap={14}>
              <Segmented<Shape>
                block
                value={shape}
                onChange={setShape}
                options={[
                  { value: 'none', label: 'As is', icon: SquareDashed },
                  { value: 'rounded', label: 'Rounded', icon: Square },
                  { value: 'circle', label: 'Circle', icon: Circle },
                  { value: 'macos', label: 'macOS', icon: AppleIcon as never },
                ]}
              />
              <Field label="Padding">
                <Slider value={padding} onChange={setPadding} min={0} max={30} format={(v) => `${v}%`} />
              </Field>
              <Field label="Fill colour behind the artwork" hint={shape === 'macos' ? 'macOS tiles are always filled.' : undefined} inline>
                <span className="iconforge__bg">
                  {(useBackground || shape === 'macos') && <input type="color" value={background} onChange={(e) => setBackground(e.target.value)} aria-label="Fill colour" />}
                  <Toggle checked={useBackground || shape === 'macos'} disabled={shape === 'macos'} onChange={setUseBackground} label="Fill background" />
                </span>
              </Field>
              <Field label="Non-square artwork" inline>
                <Segmented<'contain' | 'cover'>
                  size="sm"
                  value={fit}
                  onChange={setFit}
                  options={[
                    { value: 'contain', label: 'Fit' },
                    { value: 'cover', label: 'Crop' },
                  ]}
                />
              </Field>
            </Stack>
          </Panel>

          <Panel title="Make">
            <Stack gap={10}>
              {PACKS.map((pack) => (
                <Checkbox key={pack.id} checked={packs.includes(pack.id)} onChange={(on) => togglePack(pack.id, on)}>
                  <span className="iconforge__pack">
                    <span>{pack.name}</span>
                    <span>{pack.detail}</span>
                  </span>
                </Checkbox>
              ))}
            </Stack>
          </Panel>

        </>
      }
    >
      {!bitmap ? (
        <Dropzone
          title="Drop your logo or artwork"
          hint="PNG with transparency or an SVG works best. Square, 1024×1024 or larger."
          icon={ImageIcon}
          filters={FILTERS}
          strict
          onPaths={(paths) => load(paths[0])}
        />
      ) : (
        <>
          <Panel flush>
            <div className={cx('iconforge__stage', `iconforge__stage--${backdrop}`)}>
              <canvas ref={stageRef} className="iconforge__master" />
              <div className="iconforge__backdrop">
                <Segmented<Backdrop>
                  size="sm"
                  value={backdrop}
                  onChange={setBackdrop}
                  options={[
                    { value: 'checker', label: 'Checker' },
                    { value: 'dark', label: 'Dark' },
                    { value: 'light', label: 'Light' },
                  ]}
                />
              </div>
            </div>
            <div className="iconforge__strip">
              {STRIP.map((size) => (
                <figure key={size} className={cx('iconforge__sample', `iconforge__stage--${backdrop}`)}>
                  <canvas ref={(el) => void (stripRefs.current[size] = el)} style={{ width: size, height: size }} />
                  <figcaption>{size}</figcaption>
                </figure>
              ))}
            </div>
          </Panel>
          <Panel>
            <div className="iconforge__export">
              <Field label="Name">
                <TextInput value={name} onChange={setName} suffix="-icons/" />
              </Field>
              <Button variant="primary" size="lg" icon={FolderOutput} onClick={exportAll} disabled={!master || packs.length === 0} loading={!!busy}>
                Export to folder…
              </Button>
            </div>
            {busy && (
              <div style={{ marginTop: 12 }}>
                <Progress value={busy.done / busy.total} label="Rendering" />
              </div>
            )}
          </Panel>
          <Dropzone compact title="Use a different picture" icon={ImageIcon} filters={FILTERS} strict onPaths={(paths) => load(paths[0])}>
            <PathChip
              path={path!}
              icon={ImageIcon}
              detail={`${bitmap.width}×${bitmap.height} — drop another picture here to replace it`}
              onClear={() => {
                setBitmap(null)
                setPath(null)
              }}
            />
          </Dropzone>
        </>
      )}
    </Workbench>
  )
}
