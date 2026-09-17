import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { cx } from '@/lib/format'

type ToastKind = 'ok' | 'error' | 'info' | 'warn'

interface ToastAction {
  label: string
  run: () => void
}

interface Toast {
  id: number
  kind: ToastKind
  title: string
  detail?: string
  action?: ToastAction
}

interface ToastApi {
  ok: (title: string, opts?: { detail?: string; action?: ToastAction }) => void
  error: (title: string, opts?: { detail?: string; action?: ToastAction }) => void
  info: (title: string, opts?: { detail?: string; action?: ToastAction }) => void
  warn: (title: string, opts?: { detail?: string; action?: ToastAction }) => void
}

const Ctx = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const value = useContext(Ctx)
  if (!value) throw new Error('useToast outside ToastProvider')
  return value
}

const ICONS = { ok: CheckCircle2, error: XCircle, info: Info, warn: AlertTriangle }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), [])

  const push = useCallback(
    (kind: ToastKind, title: string, opts?: { detail?: string; action?: ToastAction }) => {
      const id = nextId.current++
      setToasts((list) => [...list.slice(-3), { id, kind, title, ...opts }])
      window.setTimeout(() => dismiss(id), kind === 'error' ? 9000 : 5000)
    },
    [dismiss],
  )

  const api = useMemo<ToastApi>(
    () => ({
      ok: (t, o) => push('ok', t, o),
      error: (t, o) => push('error', t, o),
      info: (t, o) => push('info', t, o),
      warn: (t, o) => push('warn', t, o),
    }),
    [push],
  )

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => {
          const Icon = ICONS[t.kind]
          return (
            <div key={t.id} className={cx('toast', `toast--${t.kind}`)}>
              <Icon size={17} className="toast__icon" />
              <div className="toast__body">
                <div className="toast__title">{t.title}</div>
                {t.detail && <div className="toast__detail">{t.detail}</div>}
              </div>
              {t.action && (
                <button
                  className="toast__action"
                  onClick={() => {
                    t.action!.run()
                    dismiss(t.id)
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button className="toast__close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                <X size={14} />
              </button>
            </div>
          )
        })}
      </div>
    </Ctx.Provider>
  )
}
