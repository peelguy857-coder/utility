import { Puzzle } from 'lucide-react'
import type { UtilityMeta } from '@/lib/types'

const meta: UtilityMeta = {
  id: 'mystery-maker',
  name: 'Mystery Maker',
  tagline: 'Build an ARG-style treasure hunt: ciphers, messages hidden in pictures and sounds, locked zips, decoy folders — and the solution sheet.',
  category: 'play',
  icon: Puzzle,
  hue: 20,
  keywords: ['arg', 'puzzle', 'cipher', 'treasure hunt', 'hidden', 'steganography', 'secret', 'code', 'mystery', 'youtube', 'decode', 'spectrogram'],
  order: 10,
}

export default meta
