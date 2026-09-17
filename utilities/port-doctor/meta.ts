import { Plug } from 'lucide-react'
import type { UtilityMeta } from '@/lib/types'

const meta: UtilityMeta = {
  id: 'port-doctor',
  name: 'Port Doctor',
  tagline: 'See what is listening on which port — and free a stuck one.',
  category: 'dev',
  icon: Plug,
  hue: 25,
  keywords: ['port', 'eaddrinuse', 'listen', 'netstat', 'kill', 'process', 'pid', 'localhost', 'tcp', 'udp', 'server', 'minecraft', 'node', 'zombie', 'in use'],
  order: 10,
}

export default meta
