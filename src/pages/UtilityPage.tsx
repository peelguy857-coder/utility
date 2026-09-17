import { Component, Suspense, type ReactNode } from 'react'
import { Bug, Pin, PinOff } from 'lucide-react'
import { useApp } from '@/lib/store'
import { getUtility, utilityUi } from '@/lib/registry'
import { hasBridge } from '@/lib/bridge'
import { hueStyle, UtilityIcon } from '@/components/Shell'
import { Badge, Button, Empty, Notice, Spinner } from '@/components/ui'

// One broken utility must never take the whole app down.
class Boundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <Empty icon={Bug} title="This utility crashed">
        <code>{this.state.error.message}</code>
        <div style={{ marginTop: 12 }}>
          <Button onClick={() => this.setState({ error: null })}>Try again</Button>
        </div>
      </Empty>
    )
  }
}

export function UtilityPage({ id }: { id: string }) {
  const { settings, togglePin, info } = useApp()
  const meta = getUtility(id)
  if (!meta) return <Empty icon={Bug} title="Unknown utility" />
  const Ui = utilityUi(id)
  const pinned = settings.pinned.includes(id)
  return (
    <div className="page utility tinted" style={hueStyle(meta.hue)}>
      <header className="utility__head">
        <UtilityIcon meta={meta} size="lg" />
        <div className="utility__titles">
          <h1>
            {meta.name}
            {meta.status === 'beta' && <Badge tone="warn">Beta</Badge>}
          </h1>
          <p>{meta.tagline}</p>
        </div>
        <Button variant="ghost" size="sm" icon={pinned ? PinOff : Pin} onClick={() => togglePin(id)}>
          {pinned ? 'Unpin' : 'Pin'}
        </Button>
      </header>
      {!hasBridge && info.platform === 'browser' && (
        <Notice tone="warn" title="Preview mode">
          Opened in a plain browser, so anything that needs the desktop app (files, network, system) will not work here.
        </Notice>
      )}
      <Boundary resetKey={id}>
        <Suspense
          fallback={
            <div className="utility__loading">
              <Spinner size={18} />
            </div>
          }
        >
          <Ui />
        </Suspense>
      </Boundary>
    </div>
  )
}
