import type { LucideIcon } from 'lucide-react'

export type CategoryId = 'ship' | 'phone' | 'media' | 'dev' | 'system'

export interface Category {
  id: CategoryId
  name: string
}

/** What every utility declares in utilities/<id>/meta.ts. */
export interface UtilityMeta {
  /** Must equal the folder name. */
  id: string
  name: string
  /** One short sentence shown on the card and under the title. */
  tagline: string
  category: CategoryId
  icon: LucideIcon
  /** Accent hue for this utility's tile, 0-360 (oklch hue). */
  hue: number
  keywords?: string[]
  status?: 'ready' | 'beta'
  /** Lower sorts first inside the category. Default 100. */
  order?: number
}

export type ThemeSetting = 'system' | 'dark' | 'light'

export interface AppSettings {
  theme: ThemeSetting
  pinned: string[]
  recent: string[]
  sidebarCollapsed: boolean
}

export interface AppInfo {
  name: string
  version: string
  platform: string
  username: string
  versions: { electron: string; chrome: string; node: string }
  backends: string[]
  dev: boolean
}

export type Route = { page: 'home' } | { page: 'settings' } | { page: 'utility'; id: string }

export interface FileInfo {
  path: string
  name: string
  ext: string
  size: number
  mtime: number
  isDirectory: boolean
}

export interface FileFilter {
  name: string
  extensions: string[]
}
