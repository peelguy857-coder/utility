// A stand-in for the Finder window the DMG will open: drag the two icons where you want them.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { cx } from '@/lib/format'

export interface Point {
  x: number
  y: number
}

interface DesignerProps {
  width: number
  height: number
  iconSize: number
  textSize: number
  volumeName: string
  appLabel: string
  appIcon: string | null
  showApplications: boolean
  backgroundUrl: string | null
  backgroundFit: 'cover' | 'stretch'
  appPosition: Point
  applicationsPosition: Point
  onMove: (which: 'app' | 'applications', point: Point) => void
}

function GenericAppIcon() {
  return (
    <svg viewBox="0 0 128 128" aria-hidden="true">
      <defs>
        <linearGradient id="dmg-app-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8ea2ff" />
          <stop offset="1" stopColor="#5468e8" />
        </linearGradient>
      </defs>
      <rect x="14" y="14" width="100" height="100" rx="23" fill="url(#dmg-app-g)" />
      <path d="M46 88 64 40l18 48M52 74h24" fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ApplicationsIcon() {
  return (
    <svg viewBox="0 0 128 128" aria-hidden="true">
      <defs>
        <linearGradient id="dmg-folder-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6cc4fb" />
          <stop offset="1" stopColor="#2f9bea" />
        </linearGradient>
      </defs>
      <path d="M10 34c0-6 4-10 10-10h28c4 0 6 1 9 4l6 6h45c6 0 10 4 10 10v50c0 6-4 10-10 10H20c-6 0-10-4-10-10z" fill="#4aa9ee" />
      <path d="M10 46c0-5 4-8 9-8h90c5 0 9 3 9 8v48c0 6-4 10-10 10H20c-6 0-10-4-10-10z" fill="url(#dmg-folder-g)" />
      <path d="M50 88 64 56l14 32M55 79h18" fill="none" stroke="#fff" strokeOpacity=".85" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function Designer(props: DesignerProps) {
  const { width, height, iconSize, textSize, onMove } = props
  const frameRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const drag = useRef<{ which: 'app' | 'applications'; startX: number; startY: number; origin: Point } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)

  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    const fit = () => setScale(Math.min(1, (el.clientWidth - 2) / width))
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [width])

  const clamp = (p: Point): Point => ({
    x: Math.round(Math.min(width - iconSize / 2, Math.max(iconSize / 2, p.x))),
    y: Math.round(Math.min(height - iconSize / 2 - textSize, Math.max(iconSize / 2, p.y))),
  })

  const start = (which: 'app' | 'applications', origin: Point) => (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { which, startX: e.clientX, startY: e.clientY, origin }
    setDragging(which)
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    let next = clamp({ x: d.origin.x + (e.clientX - d.startX) / scale, y: d.origin.y + (e.clientY - d.startY) / scale })
    // gentle snapping: to the other icon's row and to the vertical centre
    const other = d.which === 'app' ? props.applicationsPosition : props.appPosition
    if (!e.altKey) {
      if (Math.abs(next.y - other.y) < 7) next = { ...next, y: other.y }
      if (Math.abs(next.x - width / 2) < 7) next = { ...next, x: Math.round(width / 2) }
    }
    onMove(d.which, next)
  }
  const end = () => {
    drag.current = null
    setDragging(null)
  }
  const nudge = (which: 'app' | 'applications', origin: Point) => (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 1
    const delta: Record<string, Point> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } }
    const d = delta[e.key]
    if (!d) return
    e.preventDefault()
    onMove(which, clamp({ x: origin.x + d.x, y: origin.y + d.y }))
  }

  const item = (which: 'app' | 'applications', position: Point, label: string, icon: React.ReactNode) => (
    <div
      className={cx('dmg-item', dragging === which && 'is-dragging')}
      style={{ left: position.x - iconSize / 2, top: position.y - iconSize / 2, width: iconSize } as CSSProperties}
      tabIndex={0}
      role="button"
      aria-label={`${label}: drag or use the arrow keys to move. Now at ${position.x}, ${position.y}`}
      onPointerDown={start(which, position)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={nudge(which, position)}
    >
      <div className="dmg-item__icon" style={{ width: iconSize, height: iconSize }}>
        {icon}
      </div>
      <div className="dmg-item__label" style={{ fontSize: textSize }}>
        {label}
      </div>
    </div>
  )

  return (
    <div className="dmg-designer" ref={frameRef}>
      <div className="dmg-window" style={{ width: width * scale, height: (height + 28) * scale }}>
        <div className="dmg-window__inner" style={{ width, transform: `scale(${scale})` }}>
          <div className="dmg-window__bar">
            <span className="dmg-window__lights">
              <i />
              <i />
              <i />
            </span>
            <span className="dmg-window__title">{props.volumeName || 'Untitled'}</span>
          </div>
          <div
            className="dmg-window__content"
            style={{
              width,
              height,
              backgroundImage: props.backgroundUrl ? `url("${props.backgroundUrl}")` : undefined,
              backgroundSize: props.backgroundFit === 'stretch' ? '100% 100%' : 'cover',
            }}
          >
            {item('app', props.appPosition, props.appLabel, props.appIcon ? <img src={props.appIcon} alt="" draggable={false} /> : <GenericAppIcon />)}
            {props.showApplications && item('applications', props.applicationsPosition, 'Applications', <ApplicationsIcon />)}
          </div>
        </div>
      </div>
      <div className="dmg-designer__hint">
        Drag the icons · arrow keys nudge (Shift = 10) · hold Alt to stop snapping · {width}×{height}
      </div>
    </div>
  )
}
