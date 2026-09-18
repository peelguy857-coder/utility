import { useEffect, useMemo, useState } from 'react'
import { ArrowLeftRight, Bookmark, Pipette, Trash2 } from 'lucide-react'
import { core, errorMessage } from '@/lib/bridge'
import { cx } from '@/lib/format'
import { useToast } from '@/components/Toasts'
import { Badge, Button, CopyButton, Field, Panel, Stack, TextInput, Workbench } from '@/components/ui'
import { contrast, harmonies, parse, readable, scale, toHex, toHsl, toHsv, toOklch, type Rgb } from './lib/color'
import './ui.css'

interface Saved {
  swatches: string[]
  history: string[]
  last: string
}

declare global {
  interface Window {
    EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> }
  }
}

const f2 = (v: number) => (Math.round(v * 1000) / 1000).toString()

export default function ColorStudio() {
  const toast = useToast()
  const [text, setText] = useState('#b9f24a')
  const [color, setColor] = useState<Rgb>({ r: 185, g: 242, b: 74, a: 1 })
  const [bg, setBg] = useState<Rgb>({ r: 13, g: 14, b: 18, a: 1 })
  const [bgText, setBgText] = useState('#0d0e12')
  const [swatches, setSwatches] = useState<string[]>([])
  const [history, setHistory] = useState<string[]>([])

  useEffect(() => {
    core.getUtilSettings<Saved>('color-studio').then((s) => {
      if (s.swatches) setSwatches(s.swatches)
      if (s.history) setHistory(s.history)
      if (s.last) {
        const c = parse(s.last)
        if (c) {
          setColor(c)
          setText(s.last)
        }
      }
    })
  }, [])

  const commit = (c: Rgb, source: string) => {
    setColor(c)
    setText(source)
    const hex = toHex(c)
    setHistory((h) => {
      const next = [hex, ...h.filter((x) => x !== hex)].slice(0, 12)
      core.setUtilSettings<Saved>('color-studio', { history: next, last: source })
      return next
    })
  }

  const onText = (v: string) => {
    setText(v)
    const c = parse(v)
    if (c) commit(c, v)
  }

  const pick = async () => {
    if (!window.EyeDropper) return toast.error('The eyedropper is not available in this build')
    try {
      const { sRGBHex } = await new window.EyeDropper().open()
      commit(parse(sRGBHex)!, sRGBHex)
    } catch {
      // cancelled with Esc
    }
  }

  const save = () => {
    const hex = toHex(color)
    setSwatches((s) => {
      const next = s.includes(hex) ? s : [...s, hex].slice(-48)
      core.setUtilSettings<Saved>('color-studio', { swatches: next })
      return next
    })
  }
  const forget = (hex: string) =>
    setSwatches((s) => {
      const next = s.filter((x) => x !== hex)
      core.setUtilSettings<Saved>('color-studio', { swatches: next })
      return next
    })

  const hex = toHex(color)
  const hsl = toHsl(color)
  const hsv = toHsv(color)
  const lch = toOklch(color)
  const values = useMemo(
    () => [
      { label: 'HEX', value: color.a < 1 ? toHex(color, true) : hex },
      { label: 'RGB', value: color.a < 1 ? `rgb(${color.r} ${color.g} ${color.b} / ${color.a})` : `rgb(${color.r}, ${color.g}, ${color.b})` },
      { label: 'HSL', value: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)` },
      { label: 'HSV', value: `hsv(${hsv.h}, ${hsv.s}%, ${hsv.v}%)` },
      { label: 'OKLCH', value: `oklch(${lch.l} ${lch.c} ${lch.h})` },
      { label: 'Floats', value: `${f2(color.r / 255)}, ${f2(color.g / 255)}, ${f2(color.b / 255)}` },
      { label: 'Godot', value: `Color(${f2(color.r / 255)}, ${f2(color.g / 255)}, ${f2(color.b / 255)})` },
      { label: 'Three.js / hex int', value: `0x${hex.slice(1)}` },
      { label: 'CSS variable', value: `--color: ${hex};` },
    ],
    [color, hex, hsl, hsv, lch],
  )

  const ratio = contrast(color, bg)
  const pal = scale(color)

  return (
    <Workbench
      sideWidth={330}
      side={
        <>
          <Panel title="Contrast" hint="Text on a background, by WCAG.">
            <Stack gap={12}>
              <div className="cs__sample" style={{ background: toHex(bg), color: hex }}>
                <span className="cs__sample-big">Big heading</span>
                <span>Body text at a normal size looks like this.</span>
              </div>
              <Field label="Background">
                <div className="cs__bgrow">
                  <TextInput
                    value={bgText}
                    mono
                    onChange={(v) => {
                      setBgText(v)
                      const c = parse(v)
                      if (c) setBg(c)
                    }}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={ArrowLeftRight}
                    onClick={() => {
                      const oldBg = bg
                      setBg(color)
                      setBgText(hex)
                      commit(oldBg, toHex(oldBg))
                    }}
                  >
                    Swap
                  </Button>
                </div>
              </Field>
              <div className="cs__ratio">
                <strong>{ratio.toFixed(2)} : 1</strong>
                <span className="cs__badges">
                  <Badge tone={ratio >= 4.5 ? 'ok' : 'error'}>AA text</Badge>
                  <Badge tone={ratio >= 3 ? 'ok' : 'error'}>AA large</Badge>
                  <Badge tone={ratio >= 7 ? 'ok' : 'error'}>AAA</Badge>
                </span>
              </div>
            </Stack>
          </Panel>

          <Panel
            title="Saved"
            actions={
              <Button size="sm" variant="ghost" icon={Bookmark} onClick={save}>
                Save this one
              </Button>
            }
          >
            {swatches.length === 0 ? (
              <p className="cs__muted">Nothing saved yet. Colours you save stay here between sessions.</p>
            ) : (
              <div className="cs__swatches">
                {swatches.map((s) => (
                  <div key={s} className="cs__saved">
                    <button type="button" className="cs__chip" style={{ background: s }} title={s} onClick={() => commit(parse(s)!, s)} />
                    <button type="button" className="cs__forget" title="Forget" onClick={() => forget(s)}>
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {history.length > 0 && (
              <>
                <div className="cs__label">Recent</div>
                <div className="cs__swatches">
                  {history.map((s) => (
                    <button key={s} type="button" className="cs__chip cs__chip--sm" style={{ background: s }} title={s} onClick={() => commit(parse(s)!, s)} />
                  ))}
                </div>
              </>
            )}
          </Panel>
        </>
      }
    >
      <Panel flush>
        <div className="cs__hero" style={{ background: hex, color: readable(color) }}>
          <div className="cs__hero-hex">{hex}</div>
          <div className="cs__hero-actions">
            <Button variant="secondary" icon={Pipette} onClick={pick}>
              Pick from screen
            </Button>
            <label className="cs__native">
              <input type="color" value={hex} onChange={(e) => commit(parse(e.target.value)!, e.target.value)} />
              Colour wheel
            </label>
          </div>
        </div>
        <div className="cs__input">
          <TextInput value={text} mono onChange={onText} placeholder="#b9f24a · rgb(185 242 74) · hsl(80 87% 62%) · oklch(0.9 0.2 125) · rebeccapurple" />
          {!parse(text) && text.trim() && <span className="cs__bad">not a colour</span>}
        </div>
      </Panel>

      <Panel title="Every format">
        <div className="cs__values">
          {values.map((v) => (
            <div key={v.label} className="cs__value">
              <span className="cs__value-label">{v.label}</span>
              <code>{v.value}</code>
              <CopyButton text={v.value} label="" />
            </div>
          ))}
        </div>
      </Panel>

      <Panel
        title="Scale"
        hint="Even lightness steps in OKLCH, like a design-system palette."
        actions={<CopyButton text={() => pal.map((p) => `  --${hsl.h}-${p.step}: ${toHex(p.rgb)};`).join('\n')} label="Copy as CSS" />}
      >
        <div className="cs__scale">
          {pal.map((p) => (
            <button key={p.step} type="button" className="cs__step" style={{ background: toHex(p.rgb), color: readable(p.rgb) }} onClick={() => commit(p.rgb, toHex(p.rgb))} title={toHex(p.rgb)}>
              {p.step}
            </button>
          ))}
        </div>
      </Panel>

      <Panel title="Goes with">
        <div className="cs__harmonies">
          {harmonies(color).map((h) => (
            <div key={h.name} className="cs__harmony">
              <div className="cs__harmony-name">{h.name}</div>
              <div className="cs__harmony-row">
                {h.colors.map((c, i) => (
                  <button key={i} type="button" className={cx('cs__chip', toHex(c) === hex && 'is-current')} style={{ background: toHex(c) }} title={toHex(c)} onClick={() => commit(c, toHex(c))} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </Panel>
      <p className="cs__muted">
        Tip: <code>Esc</code> cancels the eyedropper. Values can be pasted from anywhere — Figma, CSS, Godot, Unity.
        {' '}
        {typeof errorMessage === 'function' ? '' : ''}
      </p>
    </Workbench>
  )
}
