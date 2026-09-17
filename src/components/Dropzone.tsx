import { useRef, useState, type ReactNode } from 'react'
import { FolderOpen, Upload, X, type LucideIcon } from 'lucide-react'
import { core } from '@/lib/bridge'
import { baseName, cx, dirName } from '@/lib/format'
import type { FileFilter } from '@/lib/types'

interface DropzoneProps {
  /** Called with real filesystem paths (dropped or picked). */
  onPaths: (paths: string[]) => void
  title: string
  hint?: ReactNode
  icon?: LucideIcon
  filters?: FileFilter[]
  multiple?: boolean
  /** Also offer a "choose folder" button (folders can always be dropped). */
  allowFolder?: boolean
  /** Reject dropped files whose extension is not in `filters`. Folders always pass when allowFolder is set. */
  strict?: boolean
  compact?: boolean
  disabled?: boolean
  children?: ReactNode
}

export function Dropzone({ onPaths, title, hint, icon: Icon = Upload, filters, multiple, allowFolder, strict, compact, disabled, children }: DropzoneProps) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)

  const accepts = (path: string) => {
    if (!strict || !filters?.length) return true
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    if (filters.some((f) => f.extensions.includes('*') || f.extensions.includes(ext))) return true
    return !!allowFolder && !/\.[a-z0-9]{1,5}$/i.test(baseName(path)) // no extension: probably a folder
  }

  const browse = async () => {
    if (disabled) return
    const paths = await core.pickFile({ filters, multi: multiple })
    if (paths.length) onPaths(paths)
  }

  const browseFolder = async () => {
    if (disabled) return
    const folder = await core.pickFolder()
    if (folder) onPaths([folder])
  }

  return (
    <div
      className={cx('dropzone', compact && 'dropzone--compact', over && 'is-over', disabled && 'is-disabled')}
      onDragEnter={(e) => {
        e.preventDefault()
        depth.current++
        if (!disabled) setOver(true)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        depth.current = 0
        setOver(false)
        if (disabled) return
        const paths = Array.from(e.dataTransfer.files)
          .map((f) => core.pathForFile(f))
          .filter((p) => p && accepts(p))
        if (paths.length) onPaths(multiple ? paths : paths.slice(0, 1))
      }}
    >
      {children ?? (
        <>
          <div className="dropzone__icon">
            <Icon size={compact ? 18 : 24} />
          </div>
          <div className="dropzone__text">
            <div className="dropzone__title">{title}</div>
            {hint && <div className="dropzone__hint">{hint}</div>}
          </div>
          <div className="dropzone__actions">
            <button type="button" className="btn btn--secondary btn--sm" onClick={browse} disabled={disabled}>
              <span>Browse…</span>
            </button>
            {allowFolder && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={browseFolder} disabled={disabled}>
                <FolderOpen size={14} />
                <span>Folder…</span>
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** A chosen file shown as a row with its folder, an optional preview and a clear button. */
export function PathChip({ path, icon: Icon, onClear, detail, preview }: { path: string; icon?: LucideIcon; onClear?: () => void; detail?: ReactNode; preview?: ReactNode }) {
  return (
    <div className="pathchip">
      {preview ? <div className="pathchip__preview">{preview}</div> : Icon ? <div className="pathchip__icon"><Icon size={16} /></div> : null}
      <div className="pathchip__text">
        <div className="pathchip__name" title={path}>
          {baseName(path)}
        </div>
        <div className="pathchip__dir" title={path}>
          {detail ?? dirName(path)}
        </div>
      </div>
      {onClear && (
        <button type="button" className="icon-btn" onClick={onClear} aria-label="Remove" title="Remove">
          <X size={14} />
        </button>
      )}
    </div>
  )
}
