import { useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardPaste, Copy, Download, FileCode2, Link2, Wifi } from 'lucide-react'
import { core, errorMessage } from '@/lib/bridge'
import { drawQr, qrMatrix, qrSvg, wifiPayload, type QrLevel } from '@/lib/qr'
import { useToast } from '@/components/Toasts'
import { Button, Checkbox, Field, Notice, Panel, Row, Segmented, Select, Slider, Stack, TextArea, TextInput, Workbench } from '@/components/ui'
import './ui.css'

type Mode = 'text' | 'wifi'
type Security = 'WPA' | 'WEP' | 'nopass'

export default function QrMaker() {
  const toast = useToast()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [mode, setMode] = useState<Mode>('text')
  const [text, setText] = useState('https://github.com/peelguy857-coder/utility')
  const [ssid, setSsid] = useState('')
  const [password, setPassword] = useState('')
  const [security, setSecurity] = useState<Security>('WPA')
  const [hidden, setHidden] = useState(false)
  const [level, setLevel] = useState<QrLevel>('M')
  const [size, setSize] = useState(768)
  const [rounded, setRounded] = useState(false)
  const [fg, setFg] = useState('#0d0e12')
  const [bg, setBg] = useState('#ffffff')

  const payload = mode === 'text' ? text : ssid ? wifiPayload(ssid, password, security, hidden) : ''
  const style = useMemo(() => ({ margin: 3, fg, bg, rounded }), [fg, bg, rounded])

  const result = useMemo(() => {
    if (!payload) return { matrix: null, error: null }
    try {
      return { matrix: qrMatrix(payload, level), error: null }
    } catch {
      return { matrix: null, error: 'That is too much text for one QR code. Shorten it or lower the error correction.' }
    }
  }, [payload, level])

  useEffect(() => {
    if (canvasRef.current && result.matrix) drawQr(canvasRef.current, result.matrix, size, style)
  }, [result.matrix, size, style])

  const savePng = async () => {
    try {
      const path = await core.saveFile({ defaultPath: 'qr-code.png', filters: [{ name: 'PNG image', extensions: ['png'] }] })
      if (!path || !canvasRef.current) return
      const blob = await new Promise<Blob | null>((r) => canvasRef.current!.toBlob(r, 'image/png'))
      await core.writeFile(path, await blob!.arrayBuffer())
      toast.ok('Saved QR code', { detail: path, action: { label: 'Show', run: () => core.reveal(path) } })
    } catch (err) {
      toast.error('Could not save', { detail: errorMessage(err) })
    }
  }

  const saveSvg = async () => {
    try {
      if (!result.matrix) return
      const path = await core.saveFile({ defaultPath: 'qr-code.svg', filters: [{ name: 'SVG image', extensions: ['svg'] }] })
      if (!path) return
      await core.writeFile(path, new TextEncoder().encode(qrSvg(result.matrix, style)))
      toast.ok('Saved QR code', { detail: path, action: { label: 'Show', run: () => core.reveal(path) } })
    } catch (err) {
      toast.error('Could not save', { detail: errorMessage(err) })
    }
  }

  const copy = async () => {
    if (!canvasRef.current) return
    await core.copyImage(canvasRef.current.toDataURL('image/png'))
    toast.ok('Copied image to clipboard')
  }

  return (
    <Workbench
      side={
        <>
          <Panel title="Content">
            <Stack gap={14}>
              <Segmented<Mode>
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'text', label: 'Link or text', icon: Link2 },
                  { value: 'wifi', label: 'Wi-Fi login', icon: Wifi },
                ]}
              />
              {mode === 'text' ? (
                <>
                  <TextArea value={text} onChange={setText} rows={5} mono={false} placeholder="Paste a link or type anything…" />
                  <Row justify="space-between">
                    <span className="qr__count">{new TextEncoder().encode(text).length} bytes</span>
                    <Button size="sm" variant="ghost" icon={ClipboardPaste} onClick={async () => setText(await core.readClipboard())}>
                      Paste
                    </Button>
                  </Row>
                </>
              ) : (
                <>
                  <Field label="Network name (SSID)">
                    <TextInput value={ssid} onChange={setSsid} placeholder="My Wi-Fi" />
                  </Field>
                  <Field label="Security">
                    <Select<Security>
                      value={security}
                      onChange={setSecurity}
                      options={[
                        { value: 'WPA', label: 'WPA / WPA2 / WPA3' },
                        { value: 'WEP', label: 'WEP (old)' },
                        { value: 'nopass', label: 'Open network' },
                      ]}
                    />
                  </Field>
                  {security !== 'nopass' && (
                    <Field label="Password" hint="Stays on this PC: the code is drawn locally.">
                      <TextInput value={password} onChange={setPassword} mono placeholder="password" />
                    </Field>
                  )}
                  <Checkbox checked={hidden} onChange={setHidden}>
                    Hidden network
                  </Checkbox>
                </>
              )}
            </Stack>
          </Panel>

          <Panel title="Look">
            <Stack gap={14}>
              <Field label="Error correction" hint="Higher survives scratches and logos, but makes a denser code.">
                <Segmented<QrLevel>
                  size="sm"
                  value={level}
                  onChange={setLevel}
                  options={[
                    { value: 'L', label: 'Low' },
                    { value: 'M', label: 'Medium' },
                    { value: 'Q', label: 'High' },
                    { value: 'H', label: 'Max' },
                  ]}
                />
              </Field>
              <Field label="Image size">
                <Slider value={size} onChange={setSize} min={256} max={2048} step={64} format={(v) => `${v}px`} />
              </Field>
              <Row gap={16}>
                <label className="qr__color">
                  <input type="color" value={fg} onChange={(e) => setFg(e.target.value)} />
                  <span>Code</span>
                </label>
                <label className="qr__color">
                  <input type="color" value={bg} onChange={(e) => setBg(e.target.value)} />
                  <span>Background</span>
                </label>
              </Row>
              <Checkbox checked={rounded} onChange={setRounded}>
                Rounded dots
              </Checkbox>
            </Stack>
          </Panel>
        </>
      }
    >
      <Panel flush>
        <div className="qr__stage">
          {result.matrix ? (
            <canvas ref={canvasRef} className="qr__canvas" />
          ) : (
            <div className="qr__placeholder">{result.error ?? (mode === 'wifi' ? 'Enter the network name to draw the code.' : 'Type something to draw the code.')}</div>
          )}
        </div>
        <div className="qr__actions">
          <Button variant="primary" icon={Download} onClick={savePng} disabled={!result.matrix}>
            Save PNG
          </Button>
          <Button icon={FileCode2} onClick={saveSvg} disabled={!result.matrix}>
            Save SVG
          </Button>
          <Button icon={Copy} onClick={copy} disabled={!result.matrix}>
            Copy image
          </Button>
        </div>
      </Panel>
      {result.matrix && result.matrix.length > 100 && (
        <Notice tone="warn" title="Very dense code">
          Some phone cameras struggle with this much data. A shorter link scans faster.
        </Notice>
      )}
    </Workbench>
  )
}
