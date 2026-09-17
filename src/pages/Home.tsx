import { useMemo, useState } from 'react'
import { Pin, PinOff, Search, SearchX } from 'lucide-react'
import { useApp } from '@/lib/store'
import { getUtility, search, utilities, utilitiesByCategory } from '@/lib/registry'
import { cx, formatCount, greeting, titleCase } from '@/lib/format'
import type { UtilityMeta } from '@/lib/types'
import { hueStyle, UtilityIcon } from '@/components/Shell'
import { Badge, Empty, Kbd } from '@/components/ui'

function Card({ meta }: { meta: UtilityMeta }) {
  const { navigate, settings, togglePin } = useApp()
  const pinned = settings.pinned.includes(meta.id)
  return (
    <div className="card tinted" style={hueStyle(meta.hue)}>
      <button type="button" className="card__main" onClick={() => navigate({ page: 'utility', id: meta.id })}>
        <UtilityIcon meta={meta} />
        <span className="card__name">
          {meta.name}
          {meta.status === 'beta' && <Badge tone="warn">Beta</Badge>}
        </span>
        <span className="card__tagline">{meta.tagline}</span>
      </button>
      <button
        type="button"
        className={cx('card__pin', pinned && 'is-pinned')}
        onClick={() => togglePin(meta.id)}
        aria-label={pinned ? `Unpin ${meta.name}` : `Pin ${meta.name}`}
        title={pinned ? 'Unpin' : 'Pin to sidebar'}
      >
        {pinned ? <PinOff size={14} /> : <Pin size={14} />}
      </button>
    </div>
  )
}

export function HomePage() {
  const { info, settings } = useApp()
  const [query, setQuery] = useState('')
  const results = useMemo(() => (query.trim() ? search(query) : null), [query])
  const recent = settings.recent.map(getUtility).filter((u): u is UtilityMeta => !!u).slice(0, 4)
  const name = titleCase(info.username.split(/[ ._]/)[0] ?? '')

  return (
    <div className="page home">
      <header className="home__hero">
        <h1>
          {greeting()}
          {name ? `, ${name}` : ''}.
        </h1>
        <p>
          {formatCount(utilities.length, 'utility', 'utilities')} ready. Press <Kbd>Ctrl</Kbd> <Kbd>K</Kbd> anywhere to jump straight to one.
        </p>
        <label className="home__search">
          <Search size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter utilities…" spellCheck={false} autoFocus />
        </label>
      </header>

      {results ? (
        results.length ? (
          <section className="home__section">
            <h2>{formatCount(results.length, 'match', 'matches')}</h2>
            <div className="grid">
              {results.map((meta) => (
                <Card key={meta.id} meta={meta} />
              ))}
            </div>
          </section>
        ) : (
          <Empty icon={SearchX} title={`Nothing called “${query}” yet`}>
            Tell Claude what you need and it becomes a new folder under utilities/.
          </Empty>
        )
      ) : (
        <>
          {recent.length > 0 && (
            <section className="home__section">
              <h2>Jump back in</h2>
              <div className="grid">
                {recent.map((meta) => (
                  <Card key={meta.id} meta={meta} />
                ))}
              </div>
            </section>
          )}
          {utilitiesByCategory().map(({ category, items }) => (
            <section key={category.id} className="home__section">
              <h2>{category.name}</h2>
              <div className="grid">
                {items.map((meta) => (
                  <Card key={meta.id} meta={meta} />
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  )
}
