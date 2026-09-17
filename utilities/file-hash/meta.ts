import { Fingerprint } from 'lucide-react'
import type { UtilityMeta } from '@/lib/types'

const meta: UtilityMeta = {
  id: 'file-hash',
  name: 'File Hash',
  tagline: 'Checksums for any file, and a one-paste check that a download is genuine.',
  category: 'dev',
  icon: Fingerprint,
  hue: 160,
  keywords: ['hash', 'checksum', 'md5', 'sha1', 'sha256', 'sha512', 'sha', 'verify', 'download', 'integrity', 'digest', 'sha256sum', 'fingerprint'],
  order: 30,
}

export default meta
