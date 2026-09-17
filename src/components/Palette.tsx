// Ctrl+K: jump to any utility (or a few app actions) from anywhere.
import { useEffect, useMemo, useRef, useState } from 'react'
import { CornerDownLeft, Home, Moon, Search, Settings as SettingsIcon, Sun, type LucideIcon } from 'lucide-react'
import { useApp } from '@/lib/store'
import { search } from '@/lib/registry'
import { cx } from '@/lib/format'
import type { UtilityMeta } from '@/lib/types'
import { UtilityIcon } from './Shell'
import { Kbd } from './ui'

type Item =
  | { kind: 'utility'; key: string; meta: UtilityMeta }
  | { kind: 'action'; key: string; label: string; hint: string; icon: LucideIcon; run: () => void }

export function Palette() {
  const { paletteOpen, setPaletteOpen, navigate, setTheme, settings } = useApp()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!paletteOpen) return
    setQuery('')
    setIndex(0)
    inputRef.current?.focus()
  }, [paletteOpen])

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase()
    const utils: Item[] = search(query).map((meta) => ({ kind: 'utility', key: meta.id, meta }))
    const dark = document.documentElement.dataset.theme === 'dark'
    const actions: Item[] = [
      { kind: 'action', key: 'home', label: 'Go home', hint: 'All utilities', icon: Home, run: () => navigate({ page: 'home' }) },
      { kind: 'action', key: 'settings', label: 'Open settings', hint: 'Theme, about', icon: SettingsIcon, run: () => navigate({ page: 'settings' }) },
      { kind: 'action', key: 'theme', label: dark ? 'Switch to light theme' : 'Switch to dark theme', hint: `Currently ${settings.theme}`, icon: dark ? Sun : Moon, run: () => setTheme(dark ? 'light' : 'dark') },
    ]
    return [...utils, ...actions.filter((a) => a.kind === 'action' && (!q || a.label.toLowerCase().includes(q)))]
  }, [query, navigate, setTheme, settings.theme])

  useEffect(() => setIndex(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  if (!paletteOpen) return null

  const run = (item: Item | undefined) => {
    if (!item) return
    if (item.kind === 'utility') navigate({ page: 'utility', id: item.meta.id })
    else item.run()
    setPaletteOpen(false)
  }

  return (
    <div className="palette-backdrop" onMouseDown={() => setPaletteOpen(false)}>
      <div
        className="palette"
        role="dialog"
        aria-label="Search utilities"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setIndex((i) => (i + 1) % Math.max(1, items.length))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setIndex((i) => (i - 1 + items.length) % Math.max(1, items.length))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            run(items[index])
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setPaletteOpen(false)
          }
        }}
      >
        <div className="palette__input">
          <Search size={16} />
          <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="What do you need?" spellCheck={false} />
          <Kbd>Esc</Kbd>
        </div>
        <div className="palette__list" ref={listRef}>
          {items.length === 0 && <div className="palette__empty">Nothing matches “{query}”.</div>}
          {items.map((item, i) => (
            <button key={item.key} type="button" className={cx('palette__item', i === index && 'is-selected')} onMouseMove={() => setIndex(i)} onClick={() => run(item)}>
              {item.kind === 'utility' ? (
                <UtilityIcon meta={item.meta} size="sm" />
              ) : (
                <span className="side-item__plain">
                  <item.icon size={15} />
                </span>
              )}
              <span className="palette__label">{item.kind === 'utility' ? item.meta.name : item.label}</span>
              <span className="palette__hint">{item.kind === 'utility' ? item.meta.tagline : item.hint}</span>
              {i === index && <CornerDownLeft size={13} className="palette__enter" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
