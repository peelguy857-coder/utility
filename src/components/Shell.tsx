// Window chrome: title bar, sidebar, and the tile used wherever a utility is shown.
import type { CSSProperties } from 'react'
import { ArrowLeft, ArrowRight, Home, PanelLeft, Pin, Search, Settings as SettingsIcon } from 'lucide-react'
import { useApp } from '@/lib/store'
import { utilities, utilitiesByCategory } from '@/lib/registry'
import { cx } from '@/lib/format'
import type { UtilityMeta } from '@/lib/types'
import { IconButton, Kbd } from './ui'

/** Pair with className "tinted": everything inside picks up this utility's colour via --tint. */
export const hueStyle = (hue: number) => ({ '--hue': hue }) as CSSProperties

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="logo">
      <rect x="2" y="2" width="9" height="9" rx="2.6" className="logo__dim" />
      <rect x="13" y="2" width="9" height="9" rx="2.6" className="logo__dim" />
      <rect x="2" y="13" width="9" height="9" rx="2.6" className="logo__dim" />
      <rect x="13" y="13" width="9" height="9" rx="2.6" className="logo__lit" transform="rotate(12 17.5 17.5)" />
    </svg>
  )
}

export function UtilityIcon({ meta, size = 'md' }: { meta: UtilityMeta; size?: 'sm' | 'md' | 'lg' }) {
  const px = size === 'lg' ? 26 : size === 'md' ? 20 : 15
  return (
    <span className={cx('util-icon', 'tinted', `util-icon--${size}`)} style={hueStyle(meta.hue)}>
      <meta.icon size={px} strokeWidth={size === 'sm' ? 2 : 1.8} />
    </span>
  )
}

export function Titlebar() {
  const { back, forward, canGoBack, canGoForward, setPaletteOpen, toggleSidebar, settings } = useApp()
  return (
    <header className="titlebar">
      <div className={cx('titlebar__brand', settings.sidebarCollapsed && 'is-collapsed')}>
        <Logo />
        {!settings.sidebarCollapsed && <span className="titlebar__name">Utility</span>}
      </div>
      <div className="titlebar__nav">
        <IconButton icon={PanelLeft} label="Toggle sidebar (Ctrl+B)" onClick={toggleSidebar} />
        <IconButton icon={ArrowLeft} label="Back (Alt+Left)" onClick={back} disabled={!canGoBack} />
        <IconButton icon={ArrowRight} label="Forward (Alt+Right)" onClick={forward} disabled={!canGoForward} />
      </div>
      <button type="button" className="titlebar__search" onClick={() => setPaletteOpen(true)}>
        <Search size={14} />
        <span>Search utilities</span>
        <span className="titlebar__keys">
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>
      <div className="titlebar__drag" />
    </header>
  )
}

function SideItem({ meta }: { meta: UtilityMeta }) {
  const { route, navigate, settings } = useApp()
  const active = route.page === 'utility' && route.id === meta.id
  return (
    <button type="button" className={cx('side-item', active && 'is-active')} onClick={() => navigate({ page: 'utility', id: meta.id })} title={settings.sidebarCollapsed ? meta.name : undefined}>
      <UtilityIcon meta={meta} size="sm" />
      <span className="side-item__label">{meta.name}</span>
      {meta.status === 'beta' && <span className="side-item__dot" title="Beta" />}
    </button>
  )
}

export function Sidebar() {
  const { route, navigate, settings } = useApp()
  const collapsed = settings.sidebarCollapsed
  const pinned = settings.pinned.map((id) => utilities.find((u) => u.id === id)).filter((u): u is UtilityMeta => !!u)
  return (
    <nav className={cx('sidebar', collapsed && 'is-collapsed')}>
      <div className="sidebar__scroll">
        <button type="button" className={cx('side-item', route.page === 'home' && 'is-active')} onClick={() => navigate({ page: 'home' })} title={collapsed ? 'Home' : undefined}>
          <span className="side-item__plain">
            <Home size={15} />
          </span>
          <span className="side-item__label">Home</span>
        </button>

        {pinned.length > 0 && (
          <div className="sidebar__group">
            <div className="sidebar__heading">
              <Pin size={11} />
              <span>Pinned</span>
            </div>
            {pinned.map((meta) => (
              <SideItem key={meta.id} meta={meta} />
            ))}
          </div>
        )}

        {utilitiesByCategory().map(({ category, items }) => (
          <div key={category.id} className="sidebar__group">
            <div className="sidebar__heading">
              <span>{category.name}</span>
            </div>
            {items.map((meta) => (
              <SideItem key={meta.id} meta={meta} />
            ))}
          </div>
        ))}
      </div>

      <div className="sidebar__foot">
        <button type="button" className={cx('side-item', route.page === 'settings' && 'is-active')} onClick={() => navigate({ page: 'settings' })} title={collapsed ? 'Settings' : undefined}>
          <span className="side-item__plain">
            <SettingsIcon size={15} />
          </span>
          <span className="side-item__label">Settings</span>
        </button>
      </div>
    </nav>
  )
}
