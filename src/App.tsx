import { useEffect, useRef, useState } from 'react'
import { ActiveCtx } from '@/lib/active'
import { AppProvider, useApp } from '@/lib/store'
import { core, hasBridge } from '@/lib/bridge'
import { utilities } from '@/lib/registry'
import type { Route, ThemeSetting } from '@/lib/types'
import { ToastProvider } from '@/components/Toasts'
import { Sidebar, Titlebar } from '@/components/Shell'
import { Palette } from '@/components/Palette'
import { HomePage } from '@/pages/Home'
import { UtilityPage } from '@/pages/UtilityPage'
import { SettingsPage } from '@/pages/Settings'

function Shortcuts() {
  const { setPaletteOpen, paletteOpen, navigate, back, forward, toggleSidebar } = useApp()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(!paletteOpen)
      } else if (mod && e.key.toLowerCase() === 'h') {
        e.preventDefault()
        navigate({ page: 'home' })
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
      } else if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        back()
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault()
        forward()
      }
    }
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) back()
      if (e.button === 4) forward()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [paletteOpen, setPaletteOpen, navigate, back, forward, toggleSidebar])
  return null
}

/** Lets the main process drive the UI during `npm run shots`. */
function Commands() {
  const { navigate, setTheme, setPaletteOpen } = useApp()
  const sent = useRef(false)
  useEffect(() => {
    if (!hasBridge) return
    const off = core.onCommand((command, payload) => {
      if (command === 'route') navigate(payload as Route)
      else if (command === 'theme') setTheme(payload as ThemeSetting)
      else if (command === 'palette') setPaletteOpen(!!payload)
    })
    if (!sent.current) {
      sent.current = true
      core.uiReady({ utilities: utilities.map((u) => u.id) })
    }
    return off
  }, [navigate, setTheme, setPaletteOpen])
  return null
}

function Pages() {
  const { route } = useApp()
  // Utilities stay mounted once opened, so a running job or a live mirror survives navigation.
  const [opened, setOpened] = useState<string[]>([])
  useEffect(() => {
    if (route.page === 'utility') setOpened((list) => (list.includes(route.id) ? list : [...list, route.id]))
  }, [route])
  const mainRef = useRef<HTMLElement>(null)
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [route])

  return (
    <main className="main" ref={mainRef}>
      {route.page === 'home' && <HomePage />}
      {route.page === 'settings' && <SettingsPage />}
      {opened.map((id) => {
        const active = route.page === 'utility' && route.id === id
        return (
          <div key={id} hidden={!active} className="keepalive">
            <ActiveCtx.Provider value={active}>
              <UtilityPage id={id} />
            </ActiveCtx.Provider>
          </div>
        )
      })}
    </main>
  )
}

export function App() {
  return (
    <AppProvider>
      <ToastProvider>
        <div className="app">
          <Titlebar />
          <div className="app__body">
            <Sidebar />
            <Pages />
          </div>
        </div>
        <Palette />
        <Shortcuts />
        <Commands />
      </ToastProvider>
    </AppProvider>
  )
}
