import { Rocket } from 'lucide-react'
import type { UtilityMeta } from '@/lib/types'

const meta: UtilityMeta = {
  id: 'projects',
  name: 'Project Launcher',
  tagline: 'All your projects on one page: start the dev server, watch its log, open the app, stop it — no terminal.',
  category: 'dev',
  icon: Rocket,
  hue: 45,
  keywords: ['npm', 'run', 'dev', 'server', 'start', 'launch', 'projects', 'vite', 'electron', 'node'],
  order: 5,
}

export default meta
