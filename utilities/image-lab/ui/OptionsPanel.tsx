import { FolderOpen, Link2, RotateCcw, Unlink2, X } from 'lucide-react'
import { Button, Field, IconButton, Notice, NumberInput, Panel, Row, Segmented, Select, Slider, Stack, TextInput, Toggle } from '@/components/ui'
import { DEFAULT_PATTERN, FORMAT_LABEL, PRESETS, getPreset, type Options, type OutFormat, type ResizeMode, type SizeUnit } from '../lib/options'
import { NAME_TOKENS, type Plan } from '../lib/plan'

const MODE_HINT: Record<ResizeMode, string> = {
  keep: 'Same dimensions as the original: only the format and the file size change.',
  fit: 'Shrinks the image until it fits inside the box. Nothing is cropped.',
  cover: 'Fills the box exactly and crops whatever sticks out, from the centre.',
  stretch: 'Forces this exact size and ignores the proportions.',
  scale: 'Both sides multiplied by a percentage.',
}

interface OptionsPanelProps {
  opts: Options
  /** Plain field change (the parent turns the preset into "Custom" when needed). */
  change: (patch: Partial<Options>) => void
  onPreset: (id: string) => void
  onWidth: (value: number) => void
  onHeight: (value: number) => void
  onToggleLock: () => void
  /** Present when an image is selected: copies its size into the width/height fields. */
  onUseImageSize?: () => void
  plan: Plan | null
  /** Any loaded image has transparency (decides whether the JPEG background matters). */
  anyAlpha: boolean
  batch: boolean
  destFolder: string | null
  onPickFolder: () => void
  onClearFolder: () => void
  exampleName: string
  disabled: boolean
}

export function OptionsPanel(p: OptionsPanelProps) {
  const { opts, change, plan } = p
  const lossy = opts.format !== 'png'
  const usesBox = opts.mode === 'fit' || opts.mode === 'cover' || opts.mode === 'stretch'
  const showBackground = opts.format === 'jpeg' && (p.anyAlpha || (opts.mode === 'fit' && opts.pad))

  return (
    <>
      <Panel title="Size">
        <Stack gap={14}>
          <Field label="Preset" hint={getPreset(opts.preset).summary}>
            <Select value={opts.preset} onChange={p.onPreset} options={PRESETS.map((x) => ({ value: x.id, label: x.label }))} disabled={p.disabled} />
          </Field>

          <div className="imglab__group" role="group" aria-label="Resize">
            <span className="field__label">Resize</span>
            <div className="imglab__fill">
              <Segmented<ResizeMode>
                size="sm"
                value={opts.mode}
                onChange={(mode) => change({ mode })}
                options={[
                  { value: 'keep', label: <span title="Keep size">Keep</span> },
                  { value: 'fit', label: <span title="Fit inside">Fit</span> },
                  { value: 'cover', label: <span title="Cover & crop">Cover</span> },
                  { value: 'stretch', label: <span title="Exact stretch">Stretch</span> },
                  { value: 'scale', label: <span title="Scale %">Scale %</span> },
                ]}
              />
            </div>
            <span className="field__hint">{MODE_HINT[opts.mode]}</span>
          </div>

          {usesBox && (
            <div className="imglab__dims">
              <Field label="Width">
                <NumberInput value={opts.width} onChange={p.onWidth} min={1} max={16384} suffix="px" />
              </Field>
              <IconButton icon={opts.lockAspect ? Link2 : Unlink2} label={opts.lockAspect ? 'Proportions locked: click to unlock' : 'Lock proportions'} active={opts.lockAspect} onClick={p.onToggleLock} aria-pressed={opts.lockAspect} />
              <Field label="Height">
                <NumberInput value={opts.height} onChange={p.onHeight} min={1} max={16384} suffix="px" />
              </Field>
              {p.onUseImageSize && <IconButton icon={RotateCcw} label="Use the image's own size" onClick={p.onUseImageSize} />}
            </div>
          )}

          {opts.mode === 'scale' && (
            <Field label="Scale">
              <Row gap={6}>
                <NumberInput value={opts.scale} onChange={(scale) => change({ scale })} min={1} max={400} suffix="%" width={92} />
                {[25, 50, 75].map((v) => (
                  <Button key={v} size="sm" variant={opts.scale === v ? 'secondary' : 'ghost'} onClick={() => change({ scale: v })}>
                    {v}%
                  </Button>
                ))}
              </Row>
            </Field>
          )}

          {opts.mode === 'fit' && (
            <Field inline label="Pad to the exact size" hint="Adds empty space instead of changing the shape.">
              <Toggle checked={opts.pad} onChange={(pad) => change({ pad })} label="Pad to the exact size" />
            </Field>
          )}
          {opts.mode !== 'keep' && (
            <Field inline label="Never upscale" hint="Small images stay small instead of getting blurry.">
              <Toggle checked={opts.noUpscale} onChange={(noUpscale) => change({ noUpscale })} label="Never upscale" />
            </Field>
          )}
          {plan?.upscaled && (
            <Notice tone="warn" title="This image gets enlarged">
              It is smaller than the target, so the result will look soft.
            </Notice>
          )}
        </Stack>
      </Panel>

      <Panel title="Format">
        <Stack gap={14}>
          <div className="imglab__fill">
            <Segmented<OutFormat>
              value={opts.format}
              onChange={(format) => change({ format })}
              options={(['png', 'jpeg', 'webp'] as OutFormat[]).map((value) => ({ value, label: FORMAT_LABEL[value] }))}
            />
          </div>
          {lossy ? (
            <Field label="Quality" hint={opts.format === 'webp' && opts.quality === 100 ? '100 is lossless WebP: perfect pixels, bigger file.' : undefined}>
              <Slider value={opts.quality} onChange={(quality) => change({ quality })} min={5} max={100} step={1} />
            </Field>
          ) : (
            <p className="imglab__note">PNG is lossless and keeps transparency. Best for UI, logos and pixel art; photos get large.</p>
          )}
          {showBackground && (
            <Field inline label="Background" hint="JPEG has no transparency, so see-through areas get this colour.">
              <span className="imglab__color">
                <input type="color" value={opts.background} onChange={(e) => change({ background: e.target.value })} aria-label="Background colour" />
                <span className="mono">{opts.background}</span>
              </span>
            </Field>
          )}

          <div className="imglab__sep" />

          <Field inline label="Max file size" hint={lossy ? 'Quality is lowered until the file fits.' : 'PNG cannot be squeezed: the limit is only checked.'}>
            <Toggle checked={opts.limitOn} onChange={(limitOn) => change({ limitOn })} label="Max file size" />
          </Field>
          {opts.limitOn && (
            <Row gap={8}>
              <NumberInput value={opts.limitValue} onChange={(limitValue) => change({ limitValue })} min={0.01} max={100000} step={0.1} width={120} />
              <div className="imglab__unit">
                <Select<SizeUnit>
                  value={opts.limitUnit}
                  onChange={(limitUnit) => change({ limitUnit })}
                  options={[
                    { value: 'KB', label: 'KB' },
                    { value: 'MB', label: 'MB' },
                  ]}
                />
              </div>
            </Row>
          )}
        </Stack>
      </Panel>

      <Panel title="Save as">
        <Stack gap={12}>
          <Field label="File name" hint={<span className="imglab__example">{p.exampleName}</span>}>
            <TextInput
              mono
              value={opts.pattern}
              onChange={(pattern) => change({ pattern })}
              placeholder={DEFAULT_PATTERN}
              suffix={
                opts.pattern !== DEFAULT_PATTERN ? (
                  <button type="button" className="imglab__reset" onClick={() => change({ pattern: DEFAULT_PATTERN })} title="Back to the default name">
                    Reset
                  </button>
                ) : undefined
              }
            />
          </Field>
          <div className="imglab__tokens" aria-label="Insert a placeholder">
            {NAME_TOKENS.map((token) => (
              <button key={token} type="button" className="imglab__token" onClick={() => change({ pattern: opts.pattern + token })} title={`Add ${token} to the name`}>
                {token}
              </button>
            ))}
          </div>
          {p.batch && (
            <div className="imglab__group">
              <span className="field__label">Destination folder</span>
              {p.destFolder ? (
                <div className="imglab__folder">
                  <FolderOpen size={15} />
                  <span className="imglab__folderpath" title={p.destFolder}>
                    {p.destFolder}
                  </span>
                  <IconButton icon={X} label="Forget this folder" size={14} onClick={p.onClearFolder} disabled={p.disabled} />
                </div>
              ) : (
                <span className="field__hint">Not chosen yet: you are asked when you export.</span>
              )}
              <Button size="sm" icon={FolderOpen} onClick={p.onPickFolder} disabled={p.disabled}>
                {p.destFolder ? 'Change folder…' : 'Choose folder…'}
              </Button>
            </div>
          )}
        </Stack>
      </Panel>
    </>
  )
}
