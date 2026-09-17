// The big before/after stage. It only displays: the canvases it shows are produced by ui.tsx.
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ChevronsLeftRight } from 'lucide-react'
import { Spinner } from '@/components/ui'
import { clamp, cx } from '@/lib/format'
import type { Plan } from '../lib/plan'
import type { Source } from '../lib/pipeline'

export type View = 'split' | 'result' | 'original'

export interface Size {
  width: number
  height: number
}

interface PreviewProps {
  view: View
  source: Source | null
  plan: Plan | null
  /** The planned geometry without any compression, at preview resolution. */
  before: OffscreenCanvas | null
  /** The same after encoding (what the exported file looks like). */
  after: OffscreenCanvas | null
  /** CSS size of the result frame / the original frame, already fitted to the stage by the parent. */
  resultBox: Size & { scale: number }
  originalBox: Size & { scale: number }
  busy: boolean
  onStageSize: (size: Size) => void
}

function paint(canvas: HTMLCanvasElement | null, image: CanvasImageSource | null, width?: number, height?: number) {
  if (!canvas || !image) return
  try {
    const w = width ?? (image as OffscreenCanvas).width
    const h = height ?? (image as OffscreenCanvas).height
    if (!w || !h) return
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(image, 0, 0, w, h)
  } catch {
    // the source was released while we were about to draw it: the next render brings a fresh one
  }
}

export function Preview({ view, source, plan, before, after, resultBox, originalBox, busy, onStageSize }: PreviewProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const beforeRef = useRef<HTMLCanvasElement>(null)
  const afterRef = useRef<HTMLCanvasElement>(null)
  const originalRef = useRef<HTMLCanvasElement>(null)
  const [split, setSplit] = useState(50)
  const dragging = useRef(false)
  const report = useRef(onStageSize)
  report.current = onStageSize

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => report.current({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (view === 'original') return
    paint(beforeRef.current, before)
    paint(afterRef.current, after ?? before)
  }, [view, before, after])

  useLayoutEffect(() => {
    if (view !== 'original' || !source) return
    const dpr = window.devicePixelRatio || 1
    const w = Math.min(Math.round(originalBox.width * dpr), Math.round(source.width))
    const h = Math.min(Math.round(originalBox.height * dpr), Math.round(source.height))
    paint(originalRef.current, source.proxy, Math.max(1, w), Math.max(1, h))
  }, [view, source, originalBox.width, originalBox.height])

  const moveTo = (clientX: number) => {
    const rect = frameRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    setSplit(clamp(((clientX - rect.left) / rect.width) * 100, 0, 100))
  }
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (view !== 'split' || e.button !== 0) return
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    moveTo(e.clientX)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) moveTo(e.clientX)
  }
  const onPointerUp = () => {
    dragging.current = false
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 2
    if (e.key === 'ArrowLeft') setSplit((v) => clamp(v - step, 0, 100))
    else if (e.key === 'ArrowRight') setSplit((v) => clamp(v + step, 0, 100))
    else if (e.key === 'Home') setSplit(0)
    else if (e.key === 'End') setSplit(100)
    else return
    e.preventDefault()
  }

  const showOriginal = view === 'original'
  const box = showOriginal ? originalBox : resultBox
  const ready = showOriginal ? !!source : !!before
  const zoom = Math.round(box.scale * 100)

  // crop marks on the original: which part survives "Cover & crop"
  const crop =
    showOriginal && source && plan && plan.cropped
      ? {
          left: `${(plan.sx / source.width) * 100}%`,
          top: `${(plan.sy / source.height) * 100}%`,
          width: `${(plan.sw / source.width) * 100}%`,
          height: `${(plan.sh / source.height) * 100}%`,
        }
      : null

  return (
    <div className="imglab__stage" ref={stageRef}>
      {box.width > 0 && (
        <div
          ref={frameRef}
          className={cx('imglab__frame', view === 'split' && 'is-split', box.scale > 1 && 'is-pixelated', !ready && 'is-pending')}
          style={{ width: box.width, height: box.height }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {showOriginal ? (
            <>
              <canvas ref={originalRef} className="imglab__layer" />
              {crop && <div className="imglab__crop" style={crop} />}
            </>
          ) : (
            <>
              <canvas ref={beforeRef} className="imglab__layer" style={{ visibility: view === 'split' ? 'visible' : 'hidden' }} />
              <canvas ref={afterRef} className="imglab__layer" style={view === 'split' ? { clipPath: `inset(0 0 0 ${split}%)` } : undefined} />
              {view === 'split' && ready && (
                <>
                  <span className="imglab__tag imglab__tag--left" style={{ opacity: split < 14 ? 0 : 1 }}>
                    Original
                  </span>
                  <span className="imglab__tag imglab__tag--right" style={{ opacity: split > 86 ? 0 : 1 }}>
                    Result
                  </span>
                  <div
                    className="imglab__divider"
                    style={{ left: `${split}%` }}
                    role="slider"
                    tabIndex={0}
                    aria-label="Compare original and result"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(split)}
                    onKeyDown={onKey}
                  >
                    <span className="imglab__grip">
                      <ChevronsLeftRight size={14} />
                    </span>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
      {ready && box.width > 0 && zoom !== 100 && <span className="imglab__zoom">Shown at {zoom} %</span>}
      {crop && <span className="imglab__zoom imglab__zoom--left">The bright area is what stays</span>}
      {(busy || !ready) && (
        <span className="imglab__working">
          <Spinner size={14} />
          {ready ? 'Updating…' : 'Preparing preview…'}
        </span>
      )}
    </div>
  )
}
