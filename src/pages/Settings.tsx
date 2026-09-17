import { ExternalLink, Monitor, Moon, Sun } from 'lucide-react'
import { useApp } from '@/lib/store'
import { core } from '@/lib/bridge'
import { utilities } from '@/lib/registry'
import { formatCount } from '@/lib/format'
import { Logo } from '@/components/Shell'
import { Button, Facts, Field, Kbd, Panel, Segmented, Stack } from '@/components/ui'
import type { ThemeSetting } from '@/lib/types'

const REPO = 'https://github.com/peelguy857-coder/utility'

export function SettingsPage() {
  const { settings, setTheme, info } = useApp()
  return (
    <div className="page settings">
      <header className="utility__head">
        <div className="utility__titles">
          <h1>Settings</h1>
          <p>How the app looks, and what is inside it.</p>
        </div>
      </header>

      <Stack gap={16}>
        <Panel title="Appearance">
          <Field label="Theme" hint="System follows Windows." inline>
            <Segmented<ThemeSetting>
              value={settings.theme}
              onChange={setTheme}
              options={[
                { value: 'system', label: 'System', icon: Monitor },
                { value: 'dark', label: 'Dark', icon: Moon },
                { value: 'light', label: 'Light', icon: Sun },
              ]}
            />
          </Field>
        </Panel>

        <Panel title="Keyboard">
          <div className="shortcuts">
            <div><span>Search / jump to a utility</span><span><Kbd>Ctrl</Kbd> <Kbd>K</Kbd></span></div>
            <div><span>Home</span><span><Kbd>Ctrl</Kbd> <Kbd>H</Kbd></span></div>
            <div><span>Show or hide the sidebar</span><span><Kbd>Ctrl</Kbd> <Kbd>B</Kbd></span></div>
            <div><span>Back / forward</span><span><Kbd>Alt</Kbd> <Kbd>←</Kbd> <Kbd>→</Kbd></span></div>
            <div><span>Developer tools</span><span><Kbd>F12</Kbd></span></div>
          </div>
        </Panel>

        <Panel
          title={
            <span className="about__title">
              <Logo size={18} /> Utility {info.version}
            </span>
          }
          actions={
            <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => core.openExternal(REPO)}>
              GitHub
            </Button>
          }
        >
          <p className="about__text">
            {formatCount(utilities.length, 'utility', 'utilities')} so far. Each one is a folder under <code>utilities/</code> with a <code>meta.ts</code>, a <code>ui.tsx</code> and an optional{' '}
            <code>main.cjs</code> backend — add a folder and it shows up here.
          </p>
          <Facts
            items={[
              { label: 'Electron', value: info.versions.electron, mono: true },
              { label: 'Chromium', value: info.versions.chrome, mono: true },
              { label: 'Node', value: info.versions.node, mono: true },
              { label: 'Mode', value: info.dev ? 'Development' : 'Built' },
            ]}
          />
        </Panel>
      </Stack>
    </div>
  )
}
