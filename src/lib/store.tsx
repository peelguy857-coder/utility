// App-wide state: settings (theme, pins, recents), the current route with back/forward, the palette.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { core, hasBridge } from './bridge'
import { getUtility } from './registry'
import type { AppInfo, AppSettings, Route, ThemeSetting } from './types'

const DEFAULT_SETTINGS: AppSettings = { theme: 'system', pinned: [], recent: [], sidebarCollapsed: false }
const FALLBACK_INFO: AppInfo = {
  name: 'Utility',
  version: '0.0.0',
  platform: 'browser',
  username: '',
  versions: { electron: '-', chrome: '-', node: '-' },
  backends: [],
  dev: true,
}

interface AppState {
  info: AppInfo
  settings: AppSettings
  route: Route
  canGoBack: boolean
  canGoForward: boolean
  paletteOpen: boolean
  navigate: (route: Route) => void
  back: () => void
  forward: () => void
  setTheme: (theme: ThemeSetting) => void
  togglePin: (id: string) => void
  toggleSidebar: () => void
  setPaletteOpen: (open: boolean) => void
}

const Ctx = createContext<AppState | null>(null)

export function useApp(): AppState {
  const value = useContext(Ctx)
  if (!value) throw new Error('useApp outside AppProvider')
  return value
}

const sameRoute = (a: Route, b: Route) => a.page === b.page && (a.page !== 'utility' || (b.page === 'utility' && a.id === b.id))

export function AppProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<AppInfo>(FALLBACK_INFO)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(!hasBridge)
  const [history, setHistory] = useState<{ stack: Route[]; index: number }>({ stack: [{ page: 'home' }], index: 0 })
  const [paletteOpen, setPaletteOpen] = useState(false)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  useEffect(() => {
    if (!hasBridge) return
    Promise.all([core.appInfo(), core.getSettings()])
      .then(([i, s]) => {
        setInfo(i)
        setSettings({ ...DEFAULT_SETTINGS, ...s })
      })
      .finally(() => setLoaded(true))
  }, [])

  const patch = useCallback((change: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...change }))
    if (hasBridge) core.setSettings(change).catch(() => {})
  }, [])

  // Resolve 'system' to a concrete theme and keep <html data-theme> in sync.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const theme = settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : settings.theme
      document.documentElement.dataset.theme = theme
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [settings.theme])

  const navigate = useCallback(
    (route: Route) => {
      if (route.page === 'utility' && !getUtility(route.id)) return
      setHistory((h) => {
        if (sameRoute(h.stack[h.index], route)) return h
        const stack = [...h.stack.slice(0, h.index + 1), route].slice(-50)
        return { stack, index: stack.length - 1 }
      })
      if (route.page === 'utility') {
        const recent = [route.id, ...settingsRef.current.recent.filter((id) => id !== route.id)].slice(0, 6)
        patch({ recent })
      }
      setPaletteOpen(false)
    },
    [patch],
  )

  const back = useCallback(() => setHistory((h) => (h.index > 0 ? { ...h, index: h.index - 1 } : h)), [])
  const forward = useCallback(() => setHistory((h) => (h.index < h.stack.length - 1 ? { ...h, index: h.index + 1 } : h)), [])

  const value = useMemo<AppState>(
    () => ({
      info,
      settings,
      route: history.stack[history.index],
      canGoBack: history.index > 0,
      canGoForward: history.index < history.stack.length - 1,
      paletteOpen,
      navigate,
      back,
      forward,
      setTheme: (theme) => patch({ theme }),
      togglePin: (id) => {
        const pinned = settingsRef.current.pinned
        patch({ pinned: pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id] })
      },
      toggleSidebar: () => patch({ sidebarCollapsed: !settingsRef.current.sidebarCollapsed }),
      setPaletteOpen,
    }),
    [info, settings, history, paletteOpen, navigate, back, forward, patch],
  )

  if (!loaded) return null
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
