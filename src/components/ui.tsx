// The shared UI kit. Utilities build their screens from these so everything looks like one app.
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { Check, ChevronDown, Copy, Loader2, type LucideIcon } from 'lucide-react'
import { core } from '@/lib/bridge'
import { cx } from '@/lib/format'

// ---------------------------------------------------------------- buttons

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  icon?: LucideIcon
  loading?: boolean
  block?: boolean
}

export function Button({ variant = 'secondary', size = 'md', icon: Icon, loading, block, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={cx('btn', `btn--${variant}`, `btn--${size}`, block && 'btn--block', className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 size={size === 'lg' ? 17 : 15} className="spin" /> : Icon ? <Icon size={size === 'lg' ? 17 : 15} /> : null}
      {children != null && <span>{children}</span>}
    </button>
  )
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon
  label: string
  active?: boolean
  size?: number
}

export function IconButton({ icon: Icon, label, active, size = 16, className, ...rest }: IconButtonProps) {
  return (
    <button type="button" className={cx('icon-btn', active && 'is-active', className)} aria-label={label} title={label} {...rest}>
      <Icon size={size} />
    </button>
  )
}

export function CopyButton({ text, label = 'Copy', size = 'sm' }: { text: string | (() => string); label?: string; size?: 'sm' | 'md' }) {
  const [done, setDone] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <Button
      size={size}
      variant="ghost"
      icon={done ? Check : Copy}
      onClick={async () => {
        await core.copyText(typeof text === 'function' ? text() : text)
        setDone(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setDone(false), 1400)
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  )
}

// ---------------------------------------------------------------- layout

/** Two-column work area: main content on the left, options on the right. */
export function Workbench({ children, side, sideWidth = 320 }: { children: ReactNode; side?: ReactNode; sideWidth?: number }) {
  return (
    <div className="workbench" style={side ? { gridTemplateColumns: `minmax(0, 1fr) ${sideWidth}px` } : undefined}>
      <div className="workbench__main">{children}</div>
      {side && <aside className="workbench__side">{side}</aside>}
    </div>
  )
}

export function Panel({ title, hint, actions, children, className, flush }: { title?: ReactNode; hint?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={cx('panel', flush && 'panel--flush', className)}>
      {(title || actions) && (
        <header className="panel__head">
          <div>
            {title && <h3 className="panel__title">{title}</h3>}
            {hint && <p className="panel__hint">{hint}</p>}
          </div>
          {actions && <div className="panel__actions">{actions}</div>}
        </header>
      )}
      <div className="panel__body">{children}</div>
    </section>
  )
}

export function Stack({ children, gap = 12, className }: { children: ReactNode; gap?: number; className?: string }) {
  return (
    <div className={cx('stack', className)} style={{ gap }}>
      {children}
    </div>
  )
}

export function Row({ children, gap = 8, wrap, align = 'center', justify, className }: { children: ReactNode; gap?: number; wrap?: boolean; align?: string; justify?: string; className?: string }) {
  return (
    <div className={cx('row', className)} style={{ gap, flexWrap: wrap ? 'wrap' : undefined, alignItems: align, justifyContent: justify }}>
      {children}
    </div>
  )
}

export function Empty({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__icon">
        <Icon size={22} />
      </div>
      <div className="empty__title">{title}</div>
      {children && <div className="empty__text">{children}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- form controls

export function Field({ label, hint, children, inline }: { label: ReactNode; hint?: ReactNode; children: ReactNode; inline?: boolean }) {
  return (
    <label className={cx('field', inline && 'field--inline')}>
      <span className="field__text">
        <span className="field__label">{label}</span>
        {hint && <span className="field__hint">{hint}</span>}
      </span>
      <span className="field__control">{children}</span>
    </label>
  )
}

interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  value: string
  onChange: (value: string) => void
  mono?: boolean
  suffix?: ReactNode
}

export function TextInput({ value, onChange, mono, suffix, className, ...rest }: TextInputProps) {
  return (
    <span className={cx('input', mono && 'input--mono', className)}>
      <input value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} {...rest} />
      {suffix && <span className="input__suffix">{suffix}</span>}
    </span>
  )
}

interface NumberInputProps {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  suffix?: ReactNode
  disabled?: boolean
  width?: number
}

export function NumberInput({ value, onChange, min, max, step = 1, suffix, disabled, width }: NumberInputProps) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = (raw: string) => {
    let n = Number(raw)
    if (!Number.isFinite(n)) n = value
    if (min != null) n = Math.max(min, n)
    if (max != null) n = Math.min(max, n)
    onChange(n)
    setText(String(n))
  }
  return (
    <span className="input input--number" style={width ? { width } : undefined}>
      <input
        type="number"
        value={text}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value)
          const n = Number(e.target.value)
          if (e.target.value !== '' && Number.isFinite(n) && (min == null || n >= min) && (max == null || n <= max)) onChange(n)
        }}
        onBlur={(e) => commit(e.target.value)}
      />
      {suffix && <span className="input__suffix">{suffix}</span>}
    </span>
  )
}

export function TextArea({ value, onChange, mono = true, rows = 8, placeholder, readOnly }: { value: string; onChange?: (value: string) => void; mono?: boolean; rows?: number; placeholder?: string; readOnly?: boolean }) {
  return (
    <textarea
      className={cx('textarea', mono && 'textarea--mono')}
      value={value}
      rows={rows}
      placeholder={placeholder}
      readOnly={readOnly}
      spellCheck={false}
      onChange={(e) => onChange?.(e.target.value)}
    />
  )
}

export function Select<T extends string>({ value, onChange, options, disabled }: { value: T; onChange: (value: T) => void; options: Array<{ value: T; label: string }>; disabled?: boolean }) {
  return (
    <span className="select">
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={14} className="select__chevron" />
    </span>
  )
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cx('toggle', checked && 'is-on')}
      onClick={(e) => {
        e.preventDefault()
        onChange(!checked)
      }}
    >
      <span className="toggle__knob" />
    </button>
  )
}

export function Segmented<T extends string>({ value, onChange, options, size = 'md', block }: { value: T; onChange: (value: T) => void; options: Array<{ value: T; label: ReactNode; icon?: LucideIcon }>; size?: 'sm' | 'md'; /** Stretch to the full width, items share it equally. */ block?: boolean }) {
  return (
    <div className={cx('segmented', `segmented--${size}`, block && 'segmented--block')} role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={cx('segmented__item', o.value === value && 'is-active')} onClick={() => onChange(o.value)}>
          {o.icon && <o.icon size={14} />}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Slider({ value, onChange, min, max, step = 1, format }: { value: number; onChange: (value: number) => void; min: number; max: number; step?: number; format?: (v: number) => string }) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <span className="slider">
      <input type="range" min={min} max={max} step={step} value={value} style={{ ['--pct' as string]: `${pct}%` }} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="slider__value">{format ? format(value) : value}</span>
    </span>
  )
}

export function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  const id = useId()
  return (
    <label className="checkbox" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="checkbox__box">
        <Check size={12} strokeWidth={3} />
      </span>
      <span>{children}</span>
    </label>
  )
}

// ---------------------------------------------------------------- feedback

export function Progress({ value, label, detail }: { value: number | null; label?: ReactNode; detail?: ReactNode }) {
  const pct = value == null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div className="progress">
      {(label || detail) && (
        <div className="progress__text">
          <span>{label}</span>
          <span className="progress__detail">{detail ?? (pct != null ? `${pct}%` : '')}</span>
        </div>
      )}
      <div className={cx('progress__track', pct == null && 'is-indeterminate')}>
        <div className="progress__bar" style={pct != null ? { width: `${pct}%` } : undefined} />
      </div>
    </div>
  )
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'error' | 'info' }) {
  return <span className={cx('badge', `badge--${tone}`)}>{children}</span>
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="spin" />
}

export function Notice({ tone = 'info', icon: Icon, title, children }: { tone?: 'info' | 'warn' | 'error' | 'ok'; icon?: LucideIcon; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={cx('notice', `notice--${tone}`)}>
      {Icon && <Icon size={16} className="notice__icon" />}
      <div>
        {title && <div className="notice__title">{title}</div>}
        {children && <div className="notice__text">{children}</div>}
      </div>
    </div>
  )
}

/** Key/value facts in a compact grid. */
export function Facts({ items }: { items: Array<{ label: string; value: ReactNode; mono?: boolean } | null | false> }) {
  return (
    <dl className="facts">
      {items.filter(Boolean).map((item) => {
        const it = item as { label: string; value: ReactNode; mono?: boolean }
        return (
          <div key={it.label} className="facts__item">
            <dt>{it.label}</dt>
            <dd className={it.mono ? 'mono' : undefined}>{it.value}</dd>
          </div>
        )
      })}
    </dl>
  )
}

export interface LogLine {
  level?: 'debug' | 'info' | 'warn' | 'error'
  text: string
  time?: number
}

/** Monospace log that sticks to the bottom while new lines arrive. */
export function LogView({ lines, height = 180, empty = 'Nothing yet.' }: { lines: LogLine[]; height?: number | string; empty?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lines])
  return (
    <div
      ref={ref}
      className="log"
      style={{ height }}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      {lines.length === 0 ? (
        <div className="log__empty">{empty}</div>
      ) : (
        lines.map((line, i) => (
          <div key={i} className={cx('log__line', line.level && `log__line--${line.level}`)}>
            {line.time != null && <span className="log__time">{new Date(line.time).toLocaleTimeString([], { hour12: false })}</span>}
            <span>{line.text}</span>
          </div>
        ))
      )}
    </div>
  )
}
