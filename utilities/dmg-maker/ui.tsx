import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, AppWindow, CheckCircle2, Cpu, Disc3, FileArchive, FolderOpen, Hammer, Image as ImageIcon, RotateCcw, X } from 'lucide-react'
import { core, errorMessage, useBackend, useBackendEvent } from '@/lib/bridge'
import { baseName, dirName, formatBytes, formatCount, formatDuration } from '@/lib/format'
import { useToast } from '@/components/Toasts'
import { Dropzone, PathChip } from '@/components/Dropzone'
import { Badge, Button, Facts, Field, Notice, NumberInput, Panel, Progress, Row, Segmented, Select, Slider, Stack, TextInput, Toggle, Workbench } from '@/components/ui'
import { Designer } from './ui/Designer'
import './ui.css'

interface SourceInfo {
  kind: 'app-folder' | 'app-zip' | 'folder' | 'file'
  appName: string | null
  displayName: string | null
  bundleId: string | null
  version: string | null
  arch: string[]
  totalBytes: number
  fileCount: number
  folderCount: number
  symlinkCount: number
  hasUnixModes: boolean
  warnings: string[]
  icon: string | null
  hasAppIcon: boolean
}

interface BuildProgress {
  phase: 'scan' | 'layout' | 'write' | 'finalize'
  done: number
  total: number
  message?: string
}

interface BuildResult {
  outPath: string
  bytes: number
  volumeBytes: number
  fileCount: number
  ratio: number
  warnings: string[]
  ms: number
}

type IconChoice = 'app' | 'file' | 'none'

const SOURCE_FILTERS = [{ name: 'Zipped Mac app', extensions: ['zip'] }]
const IMAGE_FILTERS = [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg'] }]
const ICON_FILTERS = [{ name: 'Icon or picture', extensions: ['icns', 'png', 'jpg', 'jpeg'] }]
const SIZES = [
  { value: '540x380', label: 'Compact — 540 × 380' },
  { value: '660x400', label: 'Classic — 660 × 400' },
  { value: '800x500', label: 'Roomy — 800 × 500' },
  { value: 'custom', label: 'Custom…' },
]
const PHASES: Record<BuildProgress['phase'], string> = { scan: 'Reading the app', layout: 'Planning the disk', write: 'Writing and compressing', finalize: 'Finishing' }

const defaultPositions = (w: number, h: number) => ({ app: { x: Math.round(w * 0.27), y: Math.round(h * 0.46) }, applications: { x: Math.round(w * 0.73), y: Math.round(h * 0.46) } })

function archLabel(arch: string[]): string | null {
  const arm = arch.includes('arm64') || arch.includes('arm64e')
  const intel = arch.includes('x86_64')
  if (arm && intel) return 'Universal (Apple silicon + Intel)'
  if (arm) return 'Apple silicon'
  if (intel) return 'Intel'
  return arch.length ? arch.join(', ') : null
}

export default function DmgMaker() {
  const api = useBackend('dmg-maker')
  const toast = useToast()

  const [source, setSource] = useState<string | null>(null)
  const [info, setInfo] = useState<SourceInfo | null>(null)
  const [inspecting, setInspecting] = useState(false)

  const [volumeName, setVolumeName] = useState('')
  const [size, setSize] = useState({ width: 660, height: 400 })
  const [customSize, setCustomSize] = useState(false)
  const [iconSize, setIconSize] = useState(128)
  const [positions, setPositions] = useState(defaultPositions(660, 400))
  const [moved, setMoved] = useState(false)
  const [applicationsLink, setApplicationsLink] = useState(true)
  const [background, setBackground] = useState<string | null>(null)
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null)
  const [backgroundFit, setBackgroundFit] = useState<'cover' | 'stretch'>('cover')
  const [iconChoice, setIconChoice] = useState<IconChoice>('app')
  const [iconFile, setIconFile] = useState<string | null>(null)
  const [compression, setCompression] = useState<'zlib' | 'none'>('zlib')

  const [progress, setProgress] = useState<BuildProgress | null>(null)
  const [building, setBuilding] = useState(false)
  const [result, setResult] = useState<BuildResult | null>(null)

  useBackendEvent<BuildProgress>('dmg-maker', 'progress', setProgress)

  // keep the icons in a sensible place while the window size changes, until the user drags one
  useEffect(() => {
    if (!moved) setPositions(defaultPositions(size.width, size.height))
    else
      setPositions((p) => ({
        app: { x: Math.min(p.app.x, size.width - iconSize / 2), y: Math.min(p.app.y, size.height - iconSize / 2) },
        applications: { x: Math.min(p.applications.x, size.width - iconSize / 2), y: Math.min(p.applications.y, size.height - iconSize / 2) },
      }))
  }, [size, moved, iconSize])

  // background preview
  const lastUrl = useRef<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (lastUrl.current) URL.revokeObjectURL(lastUrl.current)
    lastUrl.current = null
    setBackgroundUrl(null)
    if (!background) return
    core
      .readFile(background)
      .then((bytes) => {
        if (cancelled) return
        const url = URL.createObjectURL(new Blob([bytes as BlobPart]))
        lastUrl.current = url
        setBackgroundUrl(url)
      })
      .catch((err) => toast.error('Could not load that picture', { detail: errorMessage(err) }))
    return () => {
      cancelled = true
    }
  }, [background, toast])

  const load = useCallback(
    async (path: string) => {
      setInspecting(true)
      setResult(null)
      try {
        const next = await api.invoke<SourceInfo>('inspect', { source: path })
        setSource(path)
        setInfo(next)
        setVolumeName((next.displayName ?? baseName(path).replace(/\.(app|zip)$/i, '')).slice(0, 27))
        setIconChoice(next.hasAppIcon ? 'app' : 'none')
      } catch (err) {
        toast.error('Could not read that', { detail: errorMessage(err) })
      } finally {
        setInspecting(false)
      }
    },
    [api, toast],
  )

  const build = async () => {
    if (!source || !info) return
    const label = info.displayName ?? volumeName ?? 'App'
    const outPath = await core.saveFile({
      title: 'Save the disk image',
      defaultPath: `${dirName(source)}\\${label}${info.version ? ' ' + info.version : ''}.dmg`,
      filters: [{ name: 'Apple disk image', extensions: ['dmg'] }],
    })
    if (!outPath) return
    setBuilding(true)
    setResult(null)
    setProgress({ phase: 'scan', done: 0, total: 0 })
    try {
      const done = await api.invoke<BuildResult>('build', {
        source,
        outPath,
        volumeName,
        applicationsLink,
        window: size,
        iconSize,
        appPosition: positions.app,
        applicationsPosition: positions.applications,
        background: background ? { path: background, fit: backgroundFit } : null,
        volumeIcon: { kind: iconChoice, path: iconFile },
        compression,
      })
      setResult(done)
      toast.ok('DMG ready', { detail: `${baseName(done.outPath)} · ${formatBytes(done.bytes)}`, action: { label: 'Show', run: () => core.reveal(done.outPath) } })
    } catch (err) {
      const message = errorMessage(err)
      if (/abort/i.test(message)) toast.info('Build cancelled')
      else toast.error('The DMG could not be built', { detail: message })
    } finally {
      setBuilding(false)
      setProgress(null)
    }
  }

  if (!source || !info) {
    return (
      <Stack gap={16}>
        <Dropzone
          title={inspecting ? 'Reading…' : 'Drop a Mac app here'}
          hint={
            <>
              Best: the <strong>.zip</strong> your Mac build produced (GitHub Actions, electron-builder, Tauri…). It still carries the permissions and links a Mac app needs. An unzipped <strong>.app folder</strong> works too.
            </>
          }
          icon={Disc3}
          filters={SOURCE_FILTERS}
          allowFolder
          disabled={inspecting}
          onPaths={(paths) => load(paths[0])}
        />
        <div className="dmg-steps">
          <div>
            <span>1</span>
            <p>
              <strong>Drop the app.</strong> The zip is read directly, so nothing gets broken by unpacking it on Windows.
            </p>
          </div>
          <div>
            <span>2</span>
            <p>
              <strong>Design the window.</strong> Add your cover picture, drag the icons into place, pick the disk’s icon.
            </p>
          </div>
          <div>
            <span>3</span>
            <p>
              <strong>Build.</strong> You get a compressed, read-only <code>.dmg</code> that opens on any Mac with the classic drag-to-Applications layout.
            </p>
          </div>
        </div>
      </Stack>
    )
  }

  const arch = archLabel(info.arch)
  const sizeKey = customSize ? 'custom' : `${size.width}x${size.height}`
  const pct = progress && progress.total > 0 ? progress.done / progress.total : null

  return (
    <Workbench
      sideWidth={330}
      side={
        <>
          <Panel title="Disk">
            <Stack gap={14}>
              <Field label="Name" hint="Shown in Finder’s sidebar and the window title.">
                <TextInput value={volumeName} onChange={(v) => setVolumeName(v.slice(0, 27))} placeholder="My App" />
              </Field>
              <Field label="Disk icon">
                <Segmented<IconChoice>
                  block
                  size="sm"
                  value={iconChoice}
                  onChange={setIconChoice}
                  options={[
                    { value: 'app', label: 'App’s icon' },
                    { value: 'file', label: 'My own' },
                    { value: 'none', label: 'Default' },
                  ]}
                />
              </Field>
              {iconChoice === 'app' && !info.hasAppIcon && <Notice tone="info">The app’s icon can only be reused from an .app folder. With a zip, choose “My own” (an .icns from Icon Forge works).</Notice>}
              {iconChoice === 'file' &&
                (iconFile ? (
                  <PathChip path={iconFile} icon={ImageIcon} onClear={() => setIconFile(null)} />
                ) : (
                  <Dropzone compact title="Icon file" hint=".icns, or any square PNG/JPG" icon={ImageIcon} filters={ICON_FILTERS} strict onPaths={(p) => setIconFile(p[0])} />
                ))}
              <Field label="“Applications” shortcut" hint="The drag-to-install target." inline>
                <Toggle checked={applicationsLink} onChange={setApplicationsLink} label="Applications shortcut" />
              </Field>
            </Stack>
          </Panel>

          <Panel title="Window">
            <Stack gap={14}>
              <Field label="Cover picture" hint="Fills the window behind the icons. Finder writes the icon names in black (white in Dark Mode), so keep the strip under the icons calm and mid-toned.">
                {background ? (
                  <PathChip path={background} preview={backgroundUrl ? <img src={backgroundUrl} alt="" /> : undefined} icon={ImageIcon} onClear={() => setBackground(null)} />
                ) : (
                  <Dropzone compact title="Add a picture" hint={`PNG or JPG, ideally ${size.width}×${size.height} or larger`} icon={ImageIcon} filters={IMAGE_FILTERS} strict onPaths={(p) => setBackground(p[0])} />
                )}
              </Field>
              {background && (
                <Field label="Picture fit" inline>
                  <Segmented<'cover' | 'stretch'>
                    size="sm"
                    value={backgroundFit}
                    onChange={setBackgroundFit}
                    options={[
                      { value: 'cover', label: 'Fill & crop' },
                      { value: 'stretch', label: 'Stretch' },
                    ]}
                  />
                </Field>
              )}
              <Field label="Size">
                <Select
                  value={sizeKey}
                  onChange={(v) => {
                    if (v === 'custom') return setCustomSize(true)
                    const [w, h] = v.split('x').map(Number)
                    setCustomSize(false)
                    setSize({ width: w, height: h })
                  }}
                  options={SIZES}
                />
              </Field>
              {customSize && (
                <Row gap={10}>
                  <NumberInput value={size.width} onChange={(width) => setSize((s) => ({ ...s, width }))} min={320} max={1600} suffix="wide" width={140} />
                  <NumberInput value={size.height} onChange={(height) => setSize((s) => ({ ...s, height }))} min={240} max={1200} suffix="tall" width={140} />
                </Row>
              )}
              <Field label="Icon size">
                <Slider value={iconSize} onChange={setIconSize} min={64} max={192} step={8} format={(v) => `${v}px`} />
              </Field>
              {moved && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={RotateCcw}
                  onClick={() => {
                    setMoved(false)
                    setPositions(defaultPositions(size.width, size.height))
                  }}
                >
                  Reset icon positions
                </Button>
              )}
            </Stack>
          </Panel>

          <Panel title="File">
            <Field label="Compression" hint={compression === 'zlib' ? 'Smaller download. Opens everywhere.' : 'Fastest to build, biggest file.'} inline>
              <Segmented<'zlib' | 'none'>
                size="sm"
                value={compression}
                onChange={setCompression}
                options={[
                  { value: 'zlib', label: 'Compressed' },
                  { value: 'none', label: 'None' },
                ]}
              />
            </Field>
          </Panel>
        </>
      }
    >
      <Panel flush>
        <div className="dmg-source">
          <div className="dmg-source__icon">{info.icon ? <img src={info.icon} alt="" /> : info.kind === 'app-zip' ? <FileArchive size={26} /> : <AppWindow size={26} />}</div>
          <div className="dmg-source__text">
            <div className="dmg-source__name">
              {info.displayName ?? baseName(source)}
              {info.version && <Badge>{info.version}</Badge>}
              {arch && (
                <Badge tone="info">
                  <Cpu size={11} /> {arch}
                </Badge>
              )}
            </div>
            <div className="dmg-source__path" title={source}>
              {source}
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon={X}
            disabled={building}
            onClick={() => {
              setSource(null)
              setInfo(null)
              setResult(null)
            }}
          >
            Change
          </Button>
        </div>
        <div className="dmg-source__facts">
          <Facts
            items={[
              { label: 'Size', value: formatBytes(info.totalBytes) },
              { label: 'Contents', value: `${formatCount(info.fileCount, 'file')}, ${formatCount(info.symlinkCount, 'link')}` },
              info.bundleId ? { label: 'Bundle ID', value: info.bundleId, mono: true } : null,
              { label: 'Permissions', value: info.hasUnixModes ? 'Kept from the zip' : 'Worked out from the files' },
            ]}
          />
        </div>
      </Panel>

      {info.warnings.map((warning) => (
        <Notice key={warning} tone="warn" icon={AlertTriangle}>
          {warning}
        </Notice>
      ))}

      <Designer
        width={size.width}
        height={size.height}
        iconSize={iconSize}
        textSize={13}
        volumeName={volumeName}
        appLabel={info.appName?.replace(/\.app$/i, '') ?? baseName(source)}
        appIcon={info.icon}
        showApplications={applicationsLink}
        backgroundUrl={backgroundUrl}
        backgroundFit={backgroundFit}
        appPosition={positions.app}
        applicationsPosition={positions.applications}
        onMove={(which, point) => {
          setMoved(true)
          setPositions((p) => ({ ...p, [which]: point }))
        }}
      />

      <Panel>
        {building ? (
          <Stack gap={12}>
            <Progress value={pct} label={progress ? (progress.message ?? PHASES[progress.phase]) : 'Starting'} detail={progress && progress.phase === 'write' && progress.total ? `${formatBytes(progress.done)} of ${formatBytes(progress.total)}` : undefined} />
            <Row justify="flex-end">
              <Button size="sm" variant="ghost" onClick={() => api.invoke('cancel')}>
                Cancel
              </Button>
            </Row>
          </Stack>
        ) : result ? (
          <div className="dmg-result">
            <CheckCircle2 size={22} />
            <div className="dmg-result__text">
              <strong>{baseName(result.outPath)}</strong>
              <span>
                {formatBytes(result.bytes)} · {Math.round(result.ratio * 100)}% of the original · built in {formatDuration(result.ms)}
              </span>
            </div>
            <Button icon={FolderOpen} onClick={() => core.reveal(result.outPath)}>
              Show in folder
            </Button>
            <Button variant="primary" icon={Hammer} onClick={build}>
              Build again
            </Button>
          </div>
        ) : (
          <div className="dmg-result">
            <div className="dmg-result__text">
              <strong>Ready when you are</strong>
              <span>The app is copied into the image exactly as it is — nothing in the original is changed.</span>
            </div>
            <Button variant="primary" size="lg" icon={Hammer} onClick={build}>
              Build DMG…
            </Button>
          </div>
        )}
        {result?.warnings.map((warning) => (
          <div key={warning} style={{ marginTop: 10 }}>
            <Notice tone="warn" icon={AlertTriangle}>
              {warning}
            </Notice>
          </div>
        ))}
      </Panel>
    </Workbench>
  )
}
