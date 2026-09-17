import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { ArrowRight, ClipboardCopy, Download, FolderDown, ImagePlus, Images, Save, SquareSplitHorizontal, Trash2 } from 'lucide-react'
import { core, errorMessage, hasBridge } from '@/lib/bridge'
import { baseName, cx, dirName, extOf, formatBytes, formatCount, stripExt } from '@/lib/format'
import { useToast } from '@/components/Toasts'
import { Dropzone } from '@/components/Dropzone'
import { Button, Notice, Panel, Progress, Segmented, Workbench } from '@/components/ui'
import { DEFAULT_OPTIONS, FORMAT_EXT, FORMAT_LABEL, PRESET_FIELDS, applyPreset, formatFromExt, getPreset, limitBytes, outputKey, sanitizeOptions, type Options, type OutFormat } from './lib/options'
import { buildName, fitBox, joinPath, makePlan, type Plan } from './lib/plan'
import { IMAGE_EXTENSIONS, blobToDataUrl, decodeSource, detectAlpha, encode, encodeToFit, makeThumbnail, mimeForExt, renderPlan, type Encoded, type Source } from './lib/pipeline'
import { OptionsPanel } from './ui/OptionsPanel'
import { Preview, type Size, type View } from './ui/Preview'
import { Queue, type Item } from './ui/Queue'
import './ui.css'

const ID = 'image-lab'
const FILTERS = [{ name: 'Images', extensions: IMAGE_EXTENSIONS }]
const SAVE_FILTERS: Record<OutFormat, Array<{ name: string; extensions: string[] }>> = {
  png: [{ name: 'PNG image', extensions: ['png'] }],
  jpeg: [{ name: 'JPEG image', extensions: ['jpg', 'jpeg'] }],
  webp: [{ name: 'WebP image', extensions: ['webp'] }],
}

type LoadedSource = Source & { id: string }

interface Measure extends Encoded {
  /** item id + outputKey: what this measurement belongs to. */
  key: string
  width: number
  height: number
}

interface PreviewState {
  key: string
  before: OffscreenCanvas
  after: OffscreenCanvas
}

interface Stored {
  options?: unknown
  view?: View
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
let nextId = 1

/** Copy a decoded bitmap into a canvas so nothing in React state needs an explicit close(). */
function bitmapToCanvas(bitmap: ImageBitmap): OffscreenCanvas {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
  bitmap.close()
  return canvas
}

export default function ImageLab() {
  const toast = useToast()
  const [items, setItems] = useState<Item[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [opts, setOpts] = useState<Options>(DEFAULT_OPTIONS)
  const [view, setView] = useState<View>('split')
  const [loading, setLoading] = useState<{ done: number; total: number } | null>(null)
  const [source, setSource] = useState<LoadedSource | null>(null)
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 })
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [measure, setMeasure] = useState<Measure | null>(null)
  const [phase, setPhase] = useState<'idle' | 'preview' | 'measure'>('idle')
  const [exporting, setExporting] = useState<{ done: number; total: number; name: string } | null>(null)
  const [copying, setCopying] = useState(false)
  const [destFolder, setDestFolder] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const itemsRef = useRef(items)
  itemsRef.current = items
  const sourceRef = useRef<LoadedSource | null>(null)
  const stashRef = useRef<LoadedSource | null>(null) // decoded while loading, waiting to become the selected source
  const measureRef = useRef<Measure | null>(null)
  const fullRef = useRef<{ key: string; canvas: OffscreenCanvas } | null>(null)
  const jobRef = useRef(0)
  const cancelRef = useRef(false)
  const dragDepth = useRef(0)
  const freeAspect = useRef(DEFAULT_OPTIONS.width / DEFAULT_OPTIONS.height)
  const settingsReady = useRef(false)

  const selected = items.find((i) => i.id === selectedId) ?? null
  const batch = items.length > 1
  const busy = !!loading || !!exporting
  const oKey = outputKey(opts)
  const mKey = selected ? `${selected.id}|${oKey}` : ''
  const currentMeasure = measure && measure.key === mKey ? measure : null
  const limit = limitBytes(opts)

  // ---------------------------------------------------------------- settings

  useEffect(() => {
    if (!hasBridge) {
      settingsReady.current = true
      return
    }
    let alive = true
    core
      .getUtilSettings<Stored>(ID)
      .then((stored) => {
        if (!alive) return
        if (stored.options) {
          const restored = sanitizeOptions(stored.options)
          freeAspect.current = restored.width / restored.height
          setOpts(restored)
        }
        if (stored.view === 'split' || stored.view === 'result' || stored.view === 'original') setView(stored.view)
      })
      .catch(() => {
        // no stored settings is fine: defaults stay
      })
      .finally(() => {
        settingsReady.current = true
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!hasBridge || !settingsReady.current) return
    const timer = window.setTimeout(() => {
      core.setUtilSettings<Stored>(ID, { options: opts, view }).catch(() => {})
    }, 500)
    return () => window.clearTimeout(timer)
  }, [opts, view])

  // ---------------------------------------------------------------- options

  const change = useCallback((patch: Partial<Options>) => {
    setOpts((prev) => {
      const next = { ...prev, ...patch }
      if (prev.preset !== 'custom' && PRESET_FIELDS.some((k) => k in patch && patch[k] !== prev[k])) next.preset = 'custom'
      return next
    })
  }, [])

  const aspect = () => (selected ? selected.width / selected.height : freeAspect.current) || 1

  const onWidth = (width: number) => {
    if (opts.lockAspect) change({ width, height: Math.max(1, Math.round(width / aspect())) })
    else {
      freeAspect.current = width / opts.height
      change({ width })
    }
  }
  const onHeight = (height: number) => {
    if (opts.lockAspect) change({ height, width: Math.max(1, Math.round(height * aspect())) })
    else {
      freeAspect.current = opts.width / height
      change({ height })
    }
  }
  const onToggleLock = () => {
    if (opts.lockAspect) {
      setOpts((prev) => ({ ...prev, lockAspect: false }))
      return
    }
    freeAspect.current = opts.width / opts.height
    const height = Math.max(1, Math.round(opts.width / aspect()))
    setOpts((prev) => ({ ...prev, lockAspect: true }))
    if (height !== opts.height) change({ height })
  }
  const onPreset = (id: string) => {
    setOpts((prev) => {
      const next = applyPreset(prev, id)
      freeAspect.current = next.width / next.height
      return next
    })
  }

  // ---------------------------------------------------------------- loading files

  const addPaths = useCallback(
    async (paths: string[]) => {
      const known = new Set(itemsRef.current.map((i) => i.path.toLowerCase()))
      const fresh: string[] = []
      const rejected: string[] = []
      let repeats = 0
      for (const path of paths) {
        if (!IMAGE_EXTENSIONS.includes(extOf(baseName(path)))) rejected.push(baseName(path))
        else if (known.has(path.toLowerCase())) repeats++
        else {
          known.add(path.toLowerCase())
          fresh.push(path)
        }
      }
      if (rejected.length) toast.warn(`Skipped ${formatCount(rejected.length, 'file')} that ${rejected.length === 1 ? 'is not an image' : 'are not images'}`, { detail: rejected.slice(0, 4).join(', ') + (rejected.length > 4 ? '…' : '') })
      if (repeats && !fresh.length) toast.info(repeats === 1 ? 'That image is already in the list' : 'Those images are already in the list')
      if (!fresh.length) return

      const failures: string[] = []
      setLoading({ done: 0, total: fresh.length })
      for (let i = 0; i < fresh.length; i++) {
        const path = fresh[i]
        const name = baseName(path)
        const ext = extOf(name)
        try {
          const bytes = await core.readFile(path)
          const blob = new Blob([bytes as BlobPart], { type: mimeForExt(ext) })
          const src = await decodeSource(blob, ext === 'svg')
          const id = `img${nextId++}`
          let item: Item
          try {
            item = {
              id,
              path,
              name,
              ext,
              kind: src.kind,
              bytes: blob.size,
              width: src.width,
              height: src.height,
              hasAlpha: await detectAlpha(src, ext),
              blob,
              thumbUrl: await makeThumbnail(src),
              status: 'ready',
            }
          } catch (err) {
            src.dispose()
            throw err
          }
          const first = itemsRef.current.length === 0
          if (first) {
            stashRef.current?.dispose()
            stashRef.current = { ...src, id }
          } else src.dispose()
          itemsRef.current = [...itemsRef.current, item]
          setItems((list) => [...list, item])
          setSelectedId((cur) => cur ?? id)
          if (first) {
            // width/height are unused while the size is kept, so make them start at something meaningful
            setOpts((prev) => (prev.mode === 'keep' && prev.preset === 'custom' ? { ...prev, width: item.width, height: item.height } : prev))
          }
        } catch (err) {
          failures.push(`${name}: ${errorMessage(err)}`)
        }
        setLoading({ done: i + 1, total: fresh.length })
      }
      setLoading(null)
      if (failures.length) toast.error(failures.length === 1 ? 'Could not open that image' : `Could not open ${failures.length} images`, { detail: failures.slice(0, 3).join(' · ') })
    },
    [toast],
  )

  const browse = async () => {
    try {
      const paths = await core.pickFile({ title: 'Add images', filters: FILTERS, multi: true })
      if (paths.length) await addPaths(paths)
    } catch (err) {
      toast.error('Could not open the file dialog', { detail: errorMessage(err) })
    }
  }

  const removeItem = (id: string) => {
    const list = itemsRef.current
    const index = list.findIndex((i) => i.id === id)
    if (index < 0) return
    URL.revokeObjectURL(list[index].thumbUrl)
    const next = list.filter((i) => i.id !== id)
    itemsRef.current = next
    setItems(next)
    if (selectedId === id) setSelectedId(next[Math.min(index, next.length - 1)]?.id ?? null)
  }

  const clearAll = () => {
    for (const item of itemsRef.current) URL.revokeObjectURL(item.thumbUrl)
    itemsRef.current = []
    setItems([])
    setSelectedId(null)
  }

  // ---------------------------------------------------------------- the selected image, decoded

  const replaceSource = useCallback((next: LoadedSource | null) => {
    const prev = sourceRef.current
    if (prev === next) return
    sourceRef.current = next
    setSource(next)
    prev?.dispose()
    if (fullRef.current) {
      fullRef.current.canvas.width = fullRef.current.canvas.height = 0
      fullRef.current = null
    }
  }, [])

  useEffect(() => {
    const item = itemsRef.current.find((i) => i.id === selectedId)
    if (!item) {
      replaceSource(null)
      setPreview(null)
      return
    }
    if (sourceRef.current?.id === item.id) return
    const stash = stashRef.current
    if (stash && stash.id === item.id) {
      stashRef.current = null
      replaceSource(stash)
      return
    }
    let cancelled = false
    setPreview(null)
    decodeSource(item.blob, item.kind === 'svg')
      .then((src) => {
        if (cancelled) src.dispose()
        else replaceSource({ ...src, id: item.id })
      })
      .catch((err) => {
        if (!cancelled) toast.error(`Could not open ${item.name}`, { detail: errorMessage(err) })
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, replaceSource, toast])

  // release everything when the utility goes away
  useEffect(
    () => () => {
      jobRef.current++
      cancelRef.current = true
      sourceRef.current?.dispose()
      sourceRef.current = null
      stashRef.current?.dispose()
      stashRef.current = null
      for (const item of itemsRef.current) URL.revokeObjectURL(item.thumbUrl)
    },
    [],
  )

  // ---------------------------------------------------------------- geometry

  const plan = useMemo<Plan | null>(() => (selected ? makePlan(selected.width, selected.height, opts, selected.kind === 'svg') : null), [selected, opts])
  const plans = useMemo(() => new Map(items.map((i) => [i.id, makePlan(i.width, i.height, opts, i.kind === 'svg')])), [items, opts])

  const boxes = useMemo(() => {
    const maxW = stage.width - 40
    const maxH = stage.height - 40
    const tiny = (w: number, h: number) => Math.min(4, Math.max(1, Math.floor(Math.min(320 / w, 320 / h))))
    return {
      result: plan ? fitBox(plan.outW, plan.outH, maxW, maxH, tiny(plan.outW, plan.outH)) : { width: 0, height: 0, scale: 0 },
      original: selected ? fitBox(selected.width, selected.height, maxW, maxH, tiny(selected.width, selected.height)) : { width: 0, height: 0, scale: 0 },
    }
  }, [plan, selected, stage.width, stage.height])

  // ---------------------------------------------------------------- preview, then the real measurement

  // A change of output settings makes every earlier result (sizes, "Saved" marks) out of date.
  useEffect(() => {
    measureRef.current = null
    setMeasure(null)
    setItems((list) => (list.some((i) => i.status !== 'ready' || i.result || i.error) ? list.map((i) => ({ ...i, status: 'ready', result: undefined, savedPath: undefined, error: undefined })) : list))
  }, [oKey])

  const frameW = boxes.result.width
  const frameH = boxes.result.height
  const isExporting = exporting !== null
  useEffect(() => {
    if (!source || !selected || source.id !== selected.id || !plan || frameW === 0 || isExporting) {
      setPhase('idle')
      return
    }
    const token = ++jobRef.current
    const stale = () => jobRef.current !== token
    const key = `${selected.id}|${oKey}`
    const itemId = selected.id

    const run = async () => {
      try {
        setPhase('preview')
        const dpr = window.devicePixelRatio || 1
        const k = Math.min(1, (frameW * dpr) / plan.outW)
        const before = await renderPlan(source, plan, k, null, true)
        if (stale()) return

        const known = measureRef.current?.key === key ? measureRef.current : null
        let after = before
        if (opts.format !== 'png') {
          let surface = before
          if (opts.format === 'jpeg') {
            surface = new OffscreenCanvas(before.width, before.height)
            const ctx = surface.getContext('2d')
            if (ctx) {
              ctx.fillStyle = opts.background
              ctx.fillRect(0, 0, surface.width, surface.height)
              ctx.drawImage(before, 0, 0)
            }
          }
          const blob = await encode(surface, opts.format, known?.quality ?? opts.quality)
          if (stale()) return
          after = bitmapToCanvas(await createImageBitmap(blob))
          if (stale()) return
        }
        setPreview({ key, before, after })
        if (known) {
          setPhase('idle')
          return
        }

        // the real thing, at full resolution: exact byte size, and the quality that fits the limit
        setPhase('measure')
        await sleep(280)
        if (stale()) return
        const fill = opts.format === 'jpeg' ? opts.background : null
        const fullKey = `${itemId}|${JSON.stringify(plan)}|${fill}`
        if (fullRef.current?.key !== fullKey) {
          if (fullRef.current) fullRef.current.canvas.width = fullRef.current.canvas.height = 0
          fullRef.current = null
          const canvas = await renderPlan(source, plan, 1, fill, false)
          if (stale()) {
            canvas.width = canvas.height = 0
            return
          }
          fullRef.current = { key: fullKey, canvas }
        }
        const enc = await encodeToFit(fullRef.current.canvas, opts.format, opts.quality, limitBytes(opts), stale)
        if (!enc || stale()) return
        const result: Measure = { ...enc, key, width: plan.outW, height: plan.outH }
        measureRef.current = result
        setMeasure(result)
        setItems((list) => list.map((i) => (i.id === itemId ? { ...i, result: { width: plan.outW, height: plan.outH, bytes: enc.blob.size, quality: enc.quality, fits: enc.fits } } : i)))

        if (opts.format !== 'png') {
          // show the pixels of the file that will really be written, not the quick approximation
          const real = bitmapToCanvas(await createImageBitmap(enc.blob, { resizeWidth: before.width, resizeHeight: before.height, resizeQuality: 'high' }))
          if (stale()) return
          setPreview({ key, before, after: real })
        }
        setPhase('idle')
      } catch (err) {
        if (stale()) return
        setPhase('idle')
        toast.error('Could not process this image', { detail: errorMessage(err) })
      }
    }

    const timer = window.setTimeout(() => void run(), 140)
    return () => {
      window.clearTimeout(timer)
      jobRef.current++
    }
    // `plan` and `opts` are covered by oKey + the selected image; listing them would restart the job on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, selected?.id, oKey, frameW, frameH, isExporting])

  // ---------------------------------------------------------------- producing files

  /** Full-resolution result for one item. Reuses what the preview already computed when it can. */
  const produce = async (item: Item, o: Options): Promise<{ enc: Encoded; plan: Plan }> => {
    const key = `${item.id}|${outputKey(o)}`
    const itemPlan = makePlan(item.width, item.height, o, item.kind === 'svg')
    if (measureRef.current?.key === key) return { enc: measureRef.current, plan: itemPlan }
    const cached = sourceRef.current?.id === item.id ? sourceRef.current : null
    const src = cached ?? (await decodeSource(item.blob, item.kind === 'svg'))
    let canvas: OffscreenCanvas | null = null
    try {
      canvas = await renderPlan(src, itemPlan, 1, o.format === 'jpeg' ? o.background : null, false)
      const enc = await encodeToFit(canvas, o.format, o.quality, limitBytes(o))
      if (!enc) throw new Error('Cancelled')
      return { enc, plan: itemPlan }
    } finally {
      if (canvas) canvas.width = canvas.height = 0
      if (!cached) src.dispose()
    }
  }

  const nameFor = (item: Item, itemPlan: Plan, format: OutFormat) => {
    const index = itemsRef.current.findIndex((i) => i.id === item.id) + 1
    return `${buildName(opts.pattern, { name: stripExt(item.name), width: itemPlan.outW, height: itemPlan.outH, preset: getPreset(opts.preset).label, index })}.${FORMAT_EXT[format]}`
  }

  const patchItem = (id: string, patch: Partial<Item>) => {
    itemsRef.current = itemsRef.current.map((i) => (i.id === id ? { ...i, ...patch } : i))
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...patch } : i)))
  }

  const exportOne = async () => {
    const item = selected
    if (!item || !plan) return
    try {
      const path = await core.saveFile({ title: 'Export image', defaultPath: joinPath(dirName(item.path), nameFor(item, plan, opts.format)), filters: SAVE_FILTERS[opts.format] })
      if (!path) return
      // the name the user typed wins: "cover.png" gets PNG data even if JPEG was selected
      const typed = formatFromExt(extOf(baseName(path)))
      const o = typed && typed !== opts.format ? { ...opts, format: typed } : opts
      setExporting({ done: 0, total: 1, name: baseName(path) })
      patchItem(item.id, { status: 'working', error: undefined })
      const { enc } = await produce(item, o)
      await core.writeFile(path, await enc.blob.arrayBuffer())
      patchItem(item.id, { status: enc.fits ? 'done' : 'over', savedPath: path })
      const detail = `${path} · ${formatBytes(enc.blob.size)}${o !== opts ? ` · saved as ${FORMAT_LABEL[o.format]} because of the file name` : ''}`
      const action = { label: 'Show', run: () => void core.reveal(path) }
      if (enc.fits) toast.ok('Exported', { detail, action })
      else toast.warn(`Exported, but it is over ${formatBytes(limit ?? 0)}`, { detail, action })
    } catch (err) {
      patchItem(item.id, { status: 'error', error: errorMessage(err) })
      toast.error('Could not export', { detail: errorMessage(err) })
    } finally {
      setExporting(null)
    }
  }

  const pickFolder = async (): Promise<string | null> => {
    try {
      const folder = await core.pickFolder({ title: 'Where should the images go?', defaultPath: destFolder ?? (selected ? dirName(selected.path) : undefined) })
      if (folder) setDestFolder(folder)
      return folder
    } catch (err) {
      toast.error('Could not open the folder dialog', { detail: errorMessage(err) })
      return null
    }
  }

  const exportAll = async () => {
    const list = itemsRef.current
    if (!list.length) return
    const folder = destFolder ?? (await pickFolder())
    if (!folder) return

    cancelRef.current = false
    const taken = new Set<string>()
    const exists = (path: string) =>
      core.fileInfo(path).then(
        () => true,
        () => false,
      )
    let saved = 0
    let over = 0
    let bytesIn = 0
    let bytesOut = 0
    let firstPath = ''
    const failures: string[] = []

    setExporting({ done: 0, total: list.length, name: list[0].name })
    for (let i = 0; i < list.length; i++) {
      if (cancelRef.current) break
      const item = list[i]
      setExporting({ done: i, total: list.length, name: item.name })
      patchItem(item.id, { status: 'working', error: undefined })
      try {
        const { enc, plan: itemPlan } = await produce(item, opts)
        // never overwrite: not another file of this batch, and nothing that is already in the folder
        const wanted = nameFor(item, itemPlan, opts.format)
        const stem = stripExt(wanted)
        let file = wanted
        for (let n = 2; taken.has(file.toLowerCase()) || (await exists(joinPath(folder, file))); n++) file = `${stem}-${n}.${FORMAT_EXT[opts.format]}`
        taken.add(file.toLowerCase())
        const path = joinPath(folder, file)
        await core.writeFile(path, await enc.blob.arrayBuffer())
        patchItem(item.id, { status: enc.fits ? 'done' : 'over', savedPath: path, result: { width: itemPlan.outW, height: itemPlan.outH, bytes: enc.blob.size, quality: enc.quality, fits: enc.fits } })
        saved++
        if (!enc.fits) over++
        bytesIn += item.bytes
        bytesOut += enc.blob.size
        firstPath ||= path
      } catch (err) {
        const message = errorMessage(err)
        patchItem(item.id, { status: 'error', error: message })
        failures.push(`${item.name}: ${message}`)
      }
    }
    const cancelled = cancelRef.current
    for (const item of itemsRef.current) if (item.status === 'working') patchItem(item.id, { status: 'ready' })
    setExporting(null)

    const pct = bytesIn > 0 ? Math.round((1 - bytesOut / bytesIn) * 100) : 0
    const sizes = saved ? `${formatBytes(bytesIn)} → ${formatBytes(bytesOut)} (${pct >= 0 ? `${pct} % smaller` : `${-pct} % larger`})` : ''
    const action = firstPath ? { label: 'Show', run: () => void core.reveal(firstPath) } : undefined
    if (failures.length) toast.error(`${saved} of ${list.length} exported, ${failures.length} failed`, { detail: failures.slice(0, 2).join(' · '), action })
    else if (cancelled) toast.warn(`Stopped after ${formatCount(saved, 'image')}`, { detail: folder, action })
    else if (over) toast.warn(`Exported ${formatCount(saved, 'image')}, ${over} over the size limit`, { detail: `${folder} · ${sizes}`, action })
    else toast.ok(`Exported ${formatCount(saved, 'image')}`, { detail: `${folder} · ${sizes}`, action })
  }

  const copyResult = async () => {
    if (!selected) return
    setCopying(true)
    try {
      const { enc, plan: itemPlan } = await produce(selected, opts)
      let blob = enc.blob
      if (opts.format === 'webp') {
        // the clipboard takes PNG or JPEG: repack the WebP pixels losslessly
        const canvas = bitmapToCanvas(await createImageBitmap(blob))
        blob = await canvas.convertToBlob({ type: 'image/png' })
      }
      await core.copyImage(await blobToDataUrl(blob))
      toast.ok('Copied the result', { detail: `${itemPlan.outW} × ${itemPlan.outH} px, ready to paste` })
    } catch (err) {
      toast.error('Could not copy the image', { detail: errorMessage(err) })
    } finally {
      setCopying(false)
    }
  }

  // ---------------------------------------------------------------- drag & drop on the whole screen (once images are loaded)

  const dropProps =
    items.length === 0
      ? {}
      : {
          onDragEnter: (e: DragEvent) => {
            if (!e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            dragDepth.current++
            if (!busy) setDragOver(true)
          },
          onDragOver: (e: DragEvent) => {
            if (!e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            e.dataTransfer.dropEffect = busy ? 'none' : 'copy'
          },
          onDragLeave: () => {
            dragDepth.current = Math.max(0, dragDepth.current - 1)
            if (dragDepth.current === 0) setDragOver(false)
          },
          onDrop: (e: DragEvent) => {
            dragDepth.current = 0
            setDragOver(false)
            if (e.defaultPrevented || busy) return
            e.preventDefault()
            const paths = Array.from(e.dataTransfer.files)
              .map((f) => core.pathForFile(f))
              .filter(Boolean)
            if (paths.length) void addPaths(paths)
            else toast.warn('Nothing to add', { detail: 'Drop image files from Explorer.' })
          },
        }

  // ---------------------------------------------------------------- render

  const anyAlpha = items.some((i) => i.hasAlpha)
  const exampleName = selected && plan ? nameFor(selected, plan, opts.format) : `${buildName(opts.pattern, { name: 'my-image', width: opts.width, height: opts.height, preset: getPreset(opts.preset).label, index: 1 })}.${FORMAT_EXT[opts.format]}`
  const saving = currentMeasure && selected ? Math.round((1 - currentMeasure.blob.size / selected.bytes) * 100) : null
  const previewReady = preview && selected && preview.key.startsWith(selected.id + '|') ? preview : null

  return (
    <div className="imglab" {...dropProps}>
      <Workbench
        side={
          <OptionsPanel
            opts={opts}
            change={change}
            onPreset={onPreset}
            onWidth={onWidth}
            onHeight={onHeight}
            onToggleLock={onToggleLock}
            onUseImageSize={selected ? () => change({ width: selected.width, height: selected.height }) : undefined}
            plan={plan}
            anyAlpha={anyAlpha}
            batch={batch}
            destFolder={destFolder}
            onPickFolder={() => void pickFolder()}
            onClearFolder={() => setDestFolder(null)}
            exampleName={exampleName}
            disabled={!!exporting}
          />
        }
      >
        {items.length === 0 ? (
          <>
            <Dropzone
              onPaths={(paths) => void addPaths(paths)}
              title="Drop images here"
              hint="One image or a whole batch: PNG, JPEG, WebP, GIF (first frame), BMP, AVIF or SVG. Pick a preset on the right, check the result, export."
              icon={Images}
              filters={FILTERS}
              multiple
              disabled={!!loading}
            />
            {loading && (
              <Panel>
                <Progress value={loading.done / loading.total} label="Reading images…" detail={`${loading.done} / ${loading.total}`} />
              </Panel>
            )}
          </>
        ) : (
          <>
            <Panel flush className="imglab__main">
              <div className="imglab__bar">
                <div className="imglab__file" title={selected?.path}>
                  <span className="imglab__filename">{selected?.name ?? 'No image selected'}</span>
                  {batch && selected && (
                    <span className="imglab__fileindex">
                      {items.findIndex((i) => i.id === selected.id) + 1} of {items.length}
                    </span>
                  )}
                </div>
                <Segmented<View>
                  size="sm"
                  value={view}
                  onChange={setView}
                  options={[
                    { value: 'split', label: 'Compare', icon: SquareSplitHorizontal },
                    { value: 'result', label: 'Result' },
                    { value: 'original', label: 'Original' },
                  ]}
                />
              </div>

              <Preview
                view={view}
                source={source && selected && source.id === selected.id ? source : null}
                plan={plan}
                before={previewReady?.before ?? null}
                after={previewReady?.after ?? null}
                resultBox={boxes.result}
                originalBox={boxes.original}
                busy={phase === 'preview'}
                onStageSize={setStage}
              />
              <div className="imglab__measuring" aria-hidden={phase !== 'measure'}>
                {phase === 'measure' && <Progress value={null} />}
              </div>

              {selected && plan && (
                <div
                  className="imglab__stats"
                  data-phase={phase}
                  data-width={plan.outW}
                  data-height={plan.outH}
                  data-bytes={currentMeasure?.blob.size ?? ''}
                  data-quality={currentMeasure?.quality ?? ''}
                  data-fits={currentMeasure ? String(currentMeasure.fits) : ''}
                >
                  <div className="imglab__stat">
                    <span className="imglab__statlabel">Original</span>
                    <span className="imglab__statmain">
                      {selected.width} × {selected.height}
                    </span>
                    <span className="imglab__statsub">
                      {formatBytes(selected.bytes)} · {selected.ext.toUpperCase()}
                      {selected.hasAlpha ? ' · transparent' : ''}
                    </span>
                  </div>
                  <ArrowRight size={16} className="imglab__stat-arrow" />
                  <div className="imglab__stat">
                    <span className="imglab__statlabel">Result</span>
                    <span className="imglab__statmain">
                      {plan.outW} × {plan.outH}
                    </span>
                    <span className="imglab__statsub">
                      {currentMeasure ? formatBytes(currentMeasure.blob.size) : 'measuring…'} · {FORMAT_LABEL[opts.format]}
                      {opts.format !== 'png' && ` · quality ${currentMeasure?.quality ?? opts.quality}`}
                      {currentMeasure && currentMeasure.quality < opts.quality && <span className="imglab__lowered"> (lowered to fit)</span>}
                    </span>
                  </div>
                  <div className={cx('imglab__saving', saving != null && (saving > 0 ? 'is-good' : 'is-bad'))}>
                    {saving == null ? (
                      <span className="imglab__savingvalue">…</span>
                    ) : (
                      <>
                        <span className="imglab__savingvalue">{saving >= 0 ? `−${saving} %` : `+${-saving} %`}</span>
                        <span className="imglab__savinglabel">{saving >= 0 ? 'smaller' : 'larger'}</span>
                      </>
                    )}
                  </div>
                </div>
              )}

              <div className="imglab__actions">
                {exporting ? (
                  <>
                    <div className="imglab__exporting">
                      <Progress value={exporting.total > 1 ? exporting.done / exporting.total : null} label={`Exporting ${exporting.name}`} detail={exporting.total > 1 ? `${exporting.done} / ${exporting.total}` : ''} />
                    </div>
                    {exporting.total > 1 && (
                      <Button
                        onClick={() => {
                          cancelRef.current = true
                        }}
                      >
                        Stop
                      </Button>
                    )}
                  </>
                ) : (
                  <>
                    {batch ? (
                      <Button variant="primary" icon={FolderDown} onClick={() => void exportAll()} disabled={busy}>
                        Export {items.length} images
                      </Button>
                    ) : (
                      <Button variant="primary" icon={Download} onClick={() => void exportOne()} disabled={busy || !selected}>
                        Export…
                      </Button>
                    )}
                    {batch && (
                      <Button icon={Save} onClick={() => void exportOne()} disabled={busy || !selected}>
                        Save this one…
                      </Button>
                    )}
                    <Button icon={ClipboardCopy} onClick={() => void copyResult()} loading={copying} disabled={busy || !selected}>
                      Copy result
                    </Button>
                    <span className="imglab__spacer" />
                    <Button variant="ghost" icon={ImagePlus} onClick={() => void browse()} disabled={busy}>
                      Add images
                    </Button>
                  </>
                )}
              </div>
            </Panel>

            {currentMeasure && !currentMeasure.fits && limit != null && opts.format === 'png' && (
              <Notice tone="warn" title="PNG cannot be squeezed">
                PNG is lossless, so there is no quality to lower: this result is {formatBytes(currentMeasure.blob.size)}, over your {formatBytes(limit)} limit. WebP also keeps transparency and can be squeezed to fit.
                <div className="imglab__noticeaction">
                  <Button size="sm" onClick={() => change({ format: 'webp' })}>
                    Switch to WebP
                  </Button>
                </div>
              </Notice>
            )}
            {currentMeasure && !currentMeasure.fits && limit != null && opts.format !== 'png' && (
              <Notice tone="warn" title={`Cannot get under ${formatBytes(limit)}`}>
                Even at quality {currentMeasure.quality} this image is {formatBytes(currentMeasure.blob.size)}. Use smaller dimensions or raise the limit; exporting now writes that smallest version.
              </Notice>
            )}

            {loading && (
              <Panel>
                <Progress value={loading.done / loading.total} label="Reading images…" detail={`${loading.done} / ${loading.total}`} />
              </Panel>
            )}

            {batch && (
              <Panel
                flush
                title={`Queue · ${formatCount(items.length, 'image')}`}
                hint="Every image gets the same settings. Drop more anywhere to add them."
                actions={
                  <Button size="sm" variant="ghost" icon={Trash2} onClick={clearAll} disabled={busy}>
                    Clear
                  </Button>
                }
              >
                <Queue items={items} plans={plans} selectedId={selectedId} disabled={busy} onSelect={setSelectedId} onRemove={removeItem} />
              </Panel>
            )}
            {!batch && selected && (
              <div className="imglab__single">
                <span>Drop more images anywhere to build a batch.</span>
                <Button size="sm" variant="ghost" icon={Trash2} onClick={clearAll} disabled={busy}>
                  Remove image
                </Button>
              </div>
            )}
          </>
        )}
      </Workbench>
      {dragOver && (
        <div className="imglab__veil">
          <ImagePlus size={22} />
          Drop to add to the queue
        </div>
      )}
    </div>
  )
}
