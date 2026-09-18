import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Camera, Grid3x3, Pause, Play, RotateCw } from 'lucide-react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { core, errorMessage } from '@/lib/bridge'
import { useIsActive } from '@/lib/active'
import { baseName, cx, formatBytes } from '@/lib/format'
import { useToast } from '@/components/Toasts'
import { Dropzone, PathChip } from '@/components/Dropzone'
import { Button, Facts, Field, Notice, Panel, Segmented, Select, Stack, Toggle, Workbench } from '@/components/ui'
import './ui.css'

interface Stats {
  meshes: number
  triangles: number
  vertices: number
  materials: number
  textures: Array<{ name: string; width: number; height: number }>
  animations: string[]
  size: { x: number; y: number; z: number }
  bytes: number
  warnings: string[]
}

type Backdrop = 'dark' | 'light' | 'grid'

const FILTERS = [{ name: '3D model', extensions: ['glb', 'gltf'] }]

/** Everything three.js needs, created once the canvas exists. */
class Viewer {
  renderer: THREE.WebGLRenderer
  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000)
  controls: OrbitControls
  mixer: THREE.AnimationMixer | null = null
  clips: THREE.AnimationClip[] = []
  action: THREE.AnimationAction | null = null
  root: THREE.Object3D | null = null
  grid: THREE.GridHelper
  clock = new THREE.Clock()
  raf = 0
  wireframe = false
  running = true

  constructor(public canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 0.5))
    const sun = new THREE.DirectionalLight(0xffffff, 1.2)
    sun.position.set(3, 6, 4)
    this.scene.add(sun)
    this.grid = new THREE.GridHelper(10, 20, 0x556070, 0x2a3040)
    this.grid.visible = false
    this.scene.add(this.grid)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.camera.position.set(2, 1.5, 3)
    this.loop()
  }

  loop = () => {
    this.raf = requestAnimationFrame(this.loop)
    if (!this.running) return
    const dt = this.clock.getDelta()
    this.mixer?.update(dt)
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  resize(width: number, height: number) {
    if (width < 2 || height < 2) return
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  setModel(gltf: { scene: THREE.Group; animations: THREE.AnimationClip[] }): Stats['size'] {
    if (this.root) this.scene.remove(this.root)
    this.mixer?.stopAllAction()
    this.root = gltf.scene
    this.scene.add(this.root)
    this.clips = gltf.animations
    this.mixer = gltf.animations.length ? new THREE.AnimationMixer(this.root) : null
    this.action = null
    const box = new THREE.Box3().setFromObject(this.root)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const radius = Math.max(size.x, size.y, size.z) || 1
    this.controls.target.copy(center)
    this.camera.position.copy(center).add(new THREE.Vector3(radius * 0.9, radius * 0.6, radius * 1.4))
    this.camera.near = radius / 100
    this.camera.far = radius * 100
    this.camera.updateProjectionMatrix()
    this.grid.position.y = box.min.y
    this.grid.scale.setScalar(radius / 5)
    this.applyWireframe()
    return { x: size.x, y: size.y, z: size.z }
  }

  applyWireframe() {
    this.root?.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) (m as THREE.MeshStandardMaterial).wireframe = this.wireframe
    })
  }

  play(index: number) {
    if (!this.mixer) return
    this.action?.stop()
    this.action = index >= 0 ? this.mixer.clipAction(this.clips[index]) : null
    this.action?.reset().play()
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.controls.dispose()
    this.renderer.dispose()
  }
}

function collect(root: THREE.Object3D, bytes: number, animations: THREE.AnimationClip[]): Stats {
  let meshes = 0
  let triangles = 0
  let vertices = 0
  const materials = new Set<THREE.Material>()
  const textures = new Map<THREE.Texture, { name: string; width: number; height: number }>()
  const warnings: string[] = []
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    meshes++
    const geo = mesh.geometry
    const count = geo.index ? geo.index.count : geo.attributes.position?.count ?? 0
    triangles += Math.floor(count / 3)
    vertices += geo.attributes.position?.count ?? 0
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(m)
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'] as const) {
        const tex = (m as unknown as Record<string, THREE.Texture | null>)[key]
        if (tex && !textures.has(tex)) {
          const img = tex.image as { width?: number; height?: number } | undefined
          textures.set(tex, { name: tex.name || key, width: img?.width ?? 0, height: img?.height ?? 0 })
        }
      }
    }
  })
  if (triangles > 500_000) warnings.push(`${triangles.toLocaleString()} triangles is a lot for a real-time game asset`)
  for (const t of textures.values()) if (t.width > 4096 || t.height > 4096) warnings.push(`texture "${t.name}" is ${t.width}×${t.height} — bigger than most GPUs need`)
  if (bytes > 50 * 1024 * 1024) warnings.push('over 50 MB — consider Draco/meshopt compression or smaller textures')
  return { meshes, triangles, vertices, materials: materials.size, textures: [...textures.values()], animations: animations.map((a) => a.name || 'animation'), size: { x: 0, y: 0, z: 0 }, bytes, warnings }
}

export default function ModelViewer() {
  const toast = useToast()
  const active = useIsActive()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const viewer = useRef<Viewer | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(false)
  const [backdrop, setBackdrop] = useState<Backdrop>('dark')
  const [wire, setWire] = useState(false)
  const [spin, setSpin] = useState(false)
  const [clip, setClip] = useState('-1')
  const [playing, setPlaying] = useState(true)

  useEffect(() => {
    const canvas = canvasRef.current
    const frame = frameRef.current
    if (!canvas || !frame) return
    const v = new Viewer(canvas)
    viewer.current = v
    const ro = new ResizeObserver(() => v.resize(frame.clientWidth, frame.clientHeight))
    ro.observe(frame)
    v.resize(frame.clientWidth, frame.clientHeight)
    return () => {
      ro.disconnect()
      v.dispose()
      viewer.current = null
    }
  }, [])

  useEffect(() => {
    const v = viewer.current
    if (!v) return
    v.running = active
    v.grid.visible = backdrop === 'grid'
    v.controls.autoRotate = spin
    v.wireframe = wire
    v.applyWireframe()
  }, [active, backdrop, spin, wire])

  useEffect(() => {
    const v = viewer.current
    if (!v) return
    v.play(Number(clip))
    if (v.action) v.action.paused = !playing
  }, [clip, playing])

  const load = useCallback(
    async (p: string) => {
      const v = viewer.current
      if (!v) return
      setLoading(true)
      try {
        const bytes = await core.readFile(p)
        const loader = new GLTFLoader()
        const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '')
        const size = v.setModel(gltf)
        const s = collect(gltf.scene, bytes.byteLength, gltf.animations)
        setStats({ ...s, size })
        setPath(p)
        setClip(gltf.animations.length ? '0' : '-1')
        setPlaying(true)
      } catch (err) {
        const msg = errorMessage(err)
        toast.error('Could not load that model', { detail: /draco|KHR_draco/i.test(msg) ? 'It uses Draco compression, which this viewer does not decode yet.' : /\.bin|external|textures/i.test(msg) ? 'A .gltf that references other files is not supported — export as a single .glb.' : msg })
      } finally {
        setLoading(false)
      }
    },
    [toast],
  )

  const screenshot = async () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const p = await core.saveFile({ defaultPath: `${path ? baseName(path).replace(/\.[^.]+$/, '') : 'model'}.png`, filters: [{ name: 'PNG image', extensions: ['png'] }] })
    if (!p) return
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
    await core.writeFile(p, await blob!.arrayBuffer())
    toast.ok('Screenshot saved', { detail: p, action: { label: 'Show', run: () => core.reveal(p) } })
  }

  return (
    <Workbench
      sideWidth={320}
      side={
        <>
          <Panel title="Model">
            {path ? (
              <Dropzone compact title="Replace" icon={Box} filters={FILTERS} strict onPaths={(p) => load(p[0])}>
                <PathChip path={path} icon={Box} detail={stats ? `${formatBytes(stats.bytes)} · drop another model here` : undefined} />
              </Dropzone>
            ) : (
              <Dropzone compact title="Drop a .glb" hint="or browse" icon={Box} filters={FILTERS} strict onPaths={(p) => load(p[0])} />
            )}
          </Panel>
          {stats && (
            <Panel title="Inside">
              <Stack gap={12}>
                <Facts
                  items={[
                    { label: 'Triangles', value: stats.triangles.toLocaleString() },
                    { label: 'Vertices', value: stats.vertices.toLocaleString() },
                    { label: 'Meshes', value: stats.meshes },
                    { label: 'Materials', value: stats.materials },
                    { label: 'Size (units)', value: `${stats.size.x.toFixed(2)} × ${stats.size.y.toFixed(2)} × ${stats.size.z.toFixed(2)}` },
                    { label: 'File', value: formatBytes(stats.bytes) },
                  ]}
                />
                {stats.textures.length > 0 && (
                  <div className="mv__textures">
                    <div className="mv__label">Textures</div>
                    {stats.textures.map((t, i) => (
                      <div key={i} className="mv__texture">
                        <span>{t.name}</span>
                        <span>
                          {t.width}×{t.height}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {stats.animations.length > 0 && (
                  <Field label="Animation">
                    <div className="mv__anim">
                      <Select value={clip} onChange={setClip} options={[{ value: '-1', label: 'None' }, ...stats.animations.map((a, i) => ({ value: String(i), label: a }))]} />
                      <Button size="sm" variant="ghost" icon={playing ? Pause : Play} onClick={() => setPlaying(!playing)} disabled={clip === '-1'} />
                    </div>
                  </Field>
                )}
                {stats.warnings.map((w) => (
                  <Notice key={w} tone="warn">
                    {w}
                  </Notice>
                ))}
              </Stack>
            </Panel>
          )}
          <Panel title="View">
            <Stack gap={12}>
              <Segmented<Backdrop>
                block
                size="sm"
                value={backdrop}
                onChange={setBackdrop}
                options={[
                  { value: 'dark', label: 'Dark' },
                  { value: 'light', label: 'Light' },
                  { value: 'grid', label: 'Grid', icon: Grid3x3 },
                ]}
              />
              <Field label="Wireframe" inline>
                <Toggle checked={wire} onChange={setWire} />
              </Field>
              <Field label="Auto-rotate" inline>
                <Toggle checked={spin} onChange={setSpin} />
              </Field>
              <Button icon={Camera} onClick={screenshot} disabled={!stats}>
                Save screenshot
              </Button>
            </Stack>
          </Panel>
        </>
      }
    >
      <div className={cx('mv__frame', `mv__frame--${backdrop}`)} ref={frameRef}>
        <canvas ref={canvasRef} className="mv__canvas" />
        {!stats && !loading && (
          <div className="mv__hint">
            <Box size={28} />
            <span>Drop a .glb file anywhere on this page</span>
            <span className="mv__sub">Exports from Blender, Godot, Three.js projects, Sketchfab…</span>
          </div>
        )}
        {loading && (
          <div className="mv__hint">
            <RotateCw size={22} className="spin" /> Loading…
          </div>
        )}
        <Dropzone title="" icon={Box} filters={FILTERS} strict onPaths={(p) => load(p[0])}>
          <span />
        </Dropzone>
      </div>
    </Workbench>
  )
}
