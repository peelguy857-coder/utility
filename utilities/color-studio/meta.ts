import { Pipette } from 'lucide-react'
import type { UtilityMeta } from '@/lib/types'

const meta: UtilityMeta = {
  id: 'color-studio',
  name: 'Color Studio',
  tagline: 'Pick any colour on screen, get it in every format, build a palette, check contrast.',
  category: 'media',
  icon: Pipette,
  hue: 340,
  keywords: ['color', 'colour', 'picker', 'eyedropper', 'hex', 'rgb', 'hsl', 'oklch', 'palette', 'contrast', 'godot', 'unity'],
  order: 20,
}

export default meta
