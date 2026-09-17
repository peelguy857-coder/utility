import { X } from 'lucide-react'
import { Badge, IconButton, Spinner } from '@/components/ui'
import { cx, formatBytes } from '@/lib/format'
import type { Plan } from '../lib/plan'

export type ItemStatus = 'ready' | 'working' | 'done' | 'over' | 'error'

export interface ItemResult {
  width: number
  height: number
  bytes: number
  quality: number
  fits: boolean
}

export interface Item {
  id: string
  path: string
  name: string
  ext: string
  kind: 'bitmap' | 'svg'
  bytes: number
  width: number
  height: number
  hasAlpha: boolean
  blob: Blob
  thumbUrl: string
  status: ItemStatus
  result?: ItemResult
  savedPath?: string
  error?: string
}

function Status({ item }: { item: Item }) {
  if (item.status === 'working')
    return (
      <span className="imglab__rowstatus">
        <Spinner size={13} /> Working
      </span>
    )
  if (item.status === 'done') return <Badge tone="ok">Saved</Badge>
  if (item.status === 'over') return <Badge tone="warn">Over limit</Badge>
  if (item.status === 'error') return <Badge tone="error">Failed</Badge>
  if (item.result && !item.result.fits) return <Badge tone="warn">Too big</Badge>
  return null
}

export function Queue({ items, plans, selectedId, disabled, onSelect, onRemove }: { items: Item[]; plans: Map<string, Plan>; selectedId: string | null; disabled: boolean; onSelect: (id: string) => void; onRemove: (id: string) => void }) {
  return (
    <ul className="imglab__queue">
      {items.map((item) => {
        const plan = plans.get(item.id)
        const active = item.id === selectedId
        return (
          <li key={item.id} className={cx('imglab__row', active && 'is-active')} data-status={item.status}>
            <button type="button" className="imglab__rowmain" onClick={() => onSelect(item.id)} aria-current={active} title={item.error ?? item.savedPath ?? item.path}>
              <span className="imglab__thumb">
                <img src={item.thumbUrl} alt="" draggable={false} />
              </span>
              <span className="imglab__rowtext">
                <span className="imglab__rowname">{item.name}</span>
                <span className="imglab__rowmeta">
                  {item.width} × {item.height} · {formatBytes(item.bytes)}
                  {plan && (
                    <>
                      <span className="imglab__arrow">→</span>
                      {plan.outW} × {plan.outH}
                      {item.result ? ` · ${formatBytes(item.result.bytes)}` : ''}
                    </>
                  )}
                </span>
                {item.error && <span className="imglab__rowerror">{item.error}</span>}
              </span>
            </button>
            <Status item={item} />
            <IconButton icon={X} label={`Remove ${item.name}`} size={14} onClick={() => onRemove(item.id)} disabled={disabled} />
          </li>
        )
      })}
    </ul>
  )
}
