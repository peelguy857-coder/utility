import { Box } from 'lucide-react'
import type { UtilityMeta } from '@/lib/types'

const meta: UtilityMeta = {
  id: 'model-viewer',
  name: '3D Model Viewer',
  tagline: 'Drop a .glb and spin it: triangles, materials, textures, animations and size at a glance.',
  category: 'ship',
  icon: Box,
  hue: 275,
  keywords: ['glb', 'gltf', '3d', 'model', 'mesh', 'three', 'godot', 'blender', 'viewer', 'triangles'],
  order: 40,
}

export default meta
