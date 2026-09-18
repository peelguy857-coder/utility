// Every folder under utilities/ with a meta.ts + ui.tsx shows up in the app automatically.
// meta.ts is loaded up front (cheap: a name, an icon); ui.tsx is loaded the first time it is opened.
import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { Category, CategoryId, UtilityMeta } from './types'

export const CATEGORIES: Category[] = [
  { id: 'ship', name: 'Build & ship' },
  { id: 'phone', name: 'Phone' },
  { id: 'media', name: 'Images & color' },
  { id: 'play', name: 'Games & fun' },
  { id: 'dev', name: 'Developer' },
  { id: 'system', name: 'System' },
]

const metaModules = import.meta.glob<{ default: UtilityMeta }>('../../utilities/*/meta.ts', { eager: true })
const uiModules = import.meta.glob<{ default: ComponentType }>('../../utilities/*/ui.tsx')

const categoryRank = new Map<CategoryId, number>(CATEGORIES.map((c, i) => [c.id, i]))

export const utilities: UtilityMeta[] = Object.entries(metaModules)
  .map(([file, mod]) => {
    const folder = file.split('/').at(-2)
    const meta = mod.default
    if (meta.id !== folder) console.warn(`utilities/${folder}/meta.ts declares id "${meta.id}" — it should match the folder name`)
    return meta
  })
  .filter((meta) => `../../utilities/${meta.id}/ui.tsx` in uiModules)
  .sort(
    (a, b) =>
      (categoryRank.get(a.category) ?? 99) - (categoryRank.get(b.category) ?? 99) ||
      (a.order ?? 100) - (b.order ?? 100) ||
      a.name.localeCompare(b.name),
  )

const byId = new Map(utilities.map((u) => [u.id, u]))

export const getUtility = (id: string) => byId.get(id)

export function utilitiesByCategory(list: UtilityMeta[] = utilities) {
  return CATEGORIES.map((category) => ({ category, items: list.filter((u) => u.category === category.id) })).filter((g) => g.items.length > 0)
}

const uiCache = new Map<string, LazyExoticComponent<ComponentType>>()

export function utilityUi(id: string) {
  let ui = uiCache.get(id)
  if (!ui) {
    ui = lazy(uiModules[`../../utilities/${id}/ui.tsx`])
    uiCache.set(id, ui)
  }
  return ui
}

/** Small fuzzy scorer for the search box and palette. Higher is better, 0 = no match. */
export function score(meta: UtilityMeta, query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const name = meta.name.toLowerCase()
  if (name === q) return 100
  if (name.startsWith(q)) return 80
  if (name.includes(q)) return 60
  const words = [meta.id, meta.tagline, ...(meta.keywords ?? [])].join(' ').toLowerCase()
  if (words.includes(q)) return 40
  // all query words appear somewhere
  const parts = q.split(/\s+/)
  if (parts.length > 1 && parts.every((p) => name.includes(p) || words.includes(p))) return 30
  // subsequence of the name: "dmk" -> "DMG Maker"
  let i = 0
  for (const ch of name) if (ch === q[i]) i++
  return i === q.length ? 15 : 0
}

export function search(query: string): UtilityMeta[] {
  return utilities
    .map((u) => ({ u, s: score(u, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.u)
}
