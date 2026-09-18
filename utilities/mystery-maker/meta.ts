import { Puzzle } from 'lucide-react'
import type { UtilityMeta } from '@/lib/types'

const meta: UtilityMeta = {
  id: 'mystery-maker',
  name: 'Mystery Maker',
  tagline: 'Build an ARG-style treasure hunt as a chain: one START note leads through ciphers, hidden pictures and sounds, locked zips and password pages to a secret video — as files or as a hidden website.',
  category: 'play',
  icon: Puzzle,
  hue: 20,
  keywords: ['arg', 'puzzle', 'cipher', 'treasure hunt', 'hidden', 'steganography', 'secret', 'code', 'mystery', 'youtube', 'decode', 'spectrogram'],
  order: 10,
}

export default meta
