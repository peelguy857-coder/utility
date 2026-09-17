import { QrCode } from 'lucide-react'
import type { UtilityMeta } from '@/lib/types'

const meta: UtilityMeta = {
  id: 'qr-maker',
  name: 'QR Maker',
  tagline: 'Links, text or Wi-Fi logins as a QR code you can save or copy.',
  category: 'phone',
  icon: QrCode,
  hue: 300,
  keywords: ['qr', 'code', 'wifi', 'link', 'scan', 'barcode'],
  order: 30,
}

export default meta
