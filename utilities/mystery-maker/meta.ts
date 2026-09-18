import { Puzzle } from 'lucide-react'
import type { UtilityMeta } from '@/lib/types'

const meta: UtilityMeta = {
  id: 'mystery-maker',
  name: 'Mystery Maker',
  tagline: 'Make an ARG-style treasure hunt in three steps: pick the ending, pick the puzzles, put it online. One note leads the player through hidden pages to your secret video.',
  category: 'play',
  icon: Puzzle,
  hue: 20,
  keywords: ['arg', 'puzzle', 'cipher', 'treasure hunt', 'hidden', 'steganography', 'secret', 'code', 'mystery', 'youtube', 'decode', 'spectrogram'],
  order: 10,
}

export default meta
