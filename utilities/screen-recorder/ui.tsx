import { useCallback, useEffect, useRef, useState } from 'react'
import { AppWindow, Circle, FolderOpen, Mic, MicOff, Monitor, RefreshCw, Square, Volume2, VolumeX } from 'lucide-react'
import { errorMessage, useBackend } from '@/lib/bridge'
import { useIsActive } from '@/lib/active'
import { cx, formatBytes, formatDuration } from '@/lib/format'
import { useToast } from '@/components/Toasts'
import { Badge, Button, Empty, Field, Notice, Panel, Row, Segmented, Stack } from '@/components/ui'
import './ui.css'

interface Source {
  id: string
  name: string
  kind: 'screen' | 'window'
  thumbnail: string | null
  icon: string | null
}
interface Recent {
  name: string
  path: string
  bytes: number
  mtime: number
}
type Quality = 'good' | 'high' | 'max'
const BITRATE: Record<Quality, number> = { good: 6_000_000, high: 12_000_000, max: 24_000_000 }

const FORMATS = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']


export default function ScreenRecorder() {
  const api = useBackend('screen-recorder')
  const toast = useToast()
  const active = useIsActive()
  const [sources, setSources] = useState<Source[]>([])
  const [loading, setLoading] = useState(false)
  const [kind, setKind] = useState<'screen' | 'window'>('screen')
  const [picked, setPicked] = useState<string | null>(null)
  const [systemAudio, setSystemAudio] = useState(true)
  const [mic, setMic] = useState(false)
  const [quality, setQuality] = useState<Quality>('high')
  const [countdown, setCountdown] = useState<number | null>(null)
  const [rec, setRec] = useState<{ since: number; bytes: number; path: string } | null>(null)
  const [clock, setClock] = useState(0)
  const [recent, setRecent] = useState<{ dir: string; files: Recent[] } | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const streams = useRef<MediaStream[]>([])
  const previewRef = useRef<HTMLVideoElement>(null)

  const loadSources = useCallback(async () => {
    setLoading(true)
    try {
      const list = await api.invoke<Source[]>('sources')
      setSources(list)
      setPicked((p) => (p && list.some((s) => s.id === p) ? p : list.find((s) => s.kind === 'screen')?.id ?? list[0]?.id ?? null))
    } catch (err) {
      toast.error('Could not list screens and windows', { detail: errorMessage(err) })
    } finally {
      setLoading(false)
    }
  }, [api, toast])

  const loadRecent = useCallback(() => api.invoke<{ dir: string; files: Recent[] }>('recent').then(setRecent).catch(() => {}), [api])

  useEffect(() => {
    if (active && !rec) {
      void loadSources()
      void loadRecent()
    }
  }, [active, rec, loadSources, loadRecent])
  useEffect(() => {
    if (!rec) return
    const t = window.setInterval(() => setClock(Date.now()), 500)
    return () => window.clearInterval(t)
  }, [rec])

  const stopStreams = () => {
    for (const s of streams.current) for (const t of s.getTracks()) t.stop()
    streams.current = []
  }

  const stop = () => {
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop()
  }

  const start = async () => {
    const source = sources.find((s) => s.id === picked)
    if (!source) return toast.error('Pick a screen or window first')
    const mime = FORMATS.find((m) => MediaRecorder.isTypeSupported(m))
    if (!mime) return toast.error('This build cannot record video')
    try {
      // capture the picture (and the PC's sound, when asked) from the chosen source
      // Chromium's desktop-capture constraints are not in the standard typings
      const constraints = {
        audio: systemAudio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxFrameRate: 60 } },
      } as unknown as MediaStreamConstraints
      const desktop = await navigator.mediaDevices.getUserMedia(constraints)
      streams.current.push(desktop)
      const tracks = [...desktop.getVideoTracks()]
      const audioCtx = systemAudio || mic ? new AudioContext() : null
      if (audioCtx) {
        // mix system sound and microphone into one track
        const dest = audioCtx.createMediaStreamDestination()
        if (desktop.getAudioTracks().length) audioCtx.createMediaStreamSource(new MediaStream(desktop.getAudioTracks())).connect(dest)
        if (mic) {
          try {
            const m = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
            streams.current.push(m)
            audioCtx.createMediaStreamSource(m).connect(dest)
          } catch (err) {
            toast.warn('Microphone not available', { detail: errorMessage(err) })
          }
        }
        tracks.push(...dest.stream.getAudioTracks())
      }
      const stream = new MediaStream(tracks)
      if (previewRef.current) {
        previewRef.current.srcObject = new MediaStream(desktop.getVideoTracks())
        void previewRef.current.play().catch(() => {})
      }

      for (let n = 3; n > 0; n--) {
        setCountdown(n)
        await new Promise((r) => setTimeout(r, 700))
      }
      setCountdown(null)

      const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm'
      const { path } = await api.invoke<{ path: string }>('start', { ext, label: source.kind === 'screen' ? 'Screen' : source.name })
      const r = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: BITRATE[quality], audioBitsPerSecond: 192_000 })
      let queue: Promise<void> = Promise.resolve()
      r.ondataavailable = (e) => {
        if (!e.data.size) return
        queue = queue.then(async () => {
          const res = await api.invoke<{ bytes: number }>('chunk', { data: new Uint8Array(await e.data.arrayBuffer()) })
          setRec((s) => (s ? { ...s, bytes: res.bytes } : s))
        })
      }
      r.onstop = () => {
        queue.then(async () => {
          stopStreams()
          setRec(null)
          if (previewRef.current) previewRef.current.srcObject = null
          try {
            const done = await api.invoke<{ path: string; bytes: number } | null>('stop')
            if (done) toast.ok('Recording saved', { detail: `${formatBytes(done.bytes)} · ${done.path}`, action: { label: 'Show', run: () => api.invoke('reveal', { path: done.path }) } })
            void loadRecent()
          } catch (err) {
            toast.error('Could not finish the recording', { detail: errorMessage(err) })
          }
        })
      }
      desktop.getVideoTracks()[0].onended = stop // the window was closed
      r.start(1000)
      recorder.current = r
      setRec({ since: Date.now(), bytes: 0, path })
    } catch (err) {
      stopStreams()
      setCountdown(null)
      toast.error('Could not start recording', { detail: errorMessage(err) })
    }
  }

  const shown = sources.filter((s) => s.kind === kind)

  return (
    <Stack gap={16}>
      {rec ? (
        <Panel flush>
          <div className="screc__live">
            <video ref={previewRef} muted playsInline className="screc__preview" />
            <div className="screc__livebar">
              <span className="screc__reddot" /> Recording · {formatDuration(Math.max(0, (clock || Date.now()) - rec.since)).replace(/\.\d+ s$/, ' s')} · {formatBytes(rec.bytes)}
              <span className="screc__spacer" />
              <Button variant="danger" icon={Square} onClick={stop}>
                Stop
              </Button>
            </div>
          </div>
        </Panel>
      ) : (
        <>
          <Panel
            title="What to record"
            actions={
              <Row gap={6}>
                <Segmented<'screen' | 'window'>
                  size="sm"
                  value={kind}
                  onChange={setKind}
                  options={[
                    { value: 'screen', label: 'Screens', icon: Monitor },
                    { value: 'window', label: 'Windows', icon: AppWindow },
                  ]}
                />
                <Button size="sm" variant="ghost" icon={RefreshCw} loading={loading} onClick={loadSources}>
                  Refresh
                </Button>
              </Row>
            }
          >
            {shown.length === 0 ? (
              <Empty icon={AppWindow} title={loading ? 'Looking…' : 'Nothing to show'} />
            ) : (
              <div className="screc__sources">
                {shown.map((s) => (
                  <button key={s.id} type="button" className={cx('screc__source', s.id === picked && 'is-picked')} onClick={() => setPicked(s.id)} title={s.name}>
                    <span className="screc__thumb">{s.thumbnail ? <img src={s.thumbnail} alt="" /> : <Monitor size={22} />}</span>
                    <span className="screc__name">
                      {s.icon && <img src={s.icon} alt="" className="screc__icon" />}
                      <span>{s.name}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Panel>

          <div className="screc__options">
            <Panel title="Sound">
              <Stack gap={10}>
                <Field label="PC sound (games, videos)" inline>
                  <Button size="sm" variant={systemAudio ? 'secondary' : 'ghost'} icon={systemAudio ? Volume2 : VolumeX} onClick={() => setSystemAudio(!systemAudio)}>
                    {systemAudio ? 'On' : 'Off'}
                  </Button>
                </Field>
                <Field label="Microphone" inline>
                  <Button size="sm" variant={mic ? 'secondary' : 'ghost'} icon={mic ? Mic : MicOff} onClick={() => setMic(!mic)}>
                    {mic ? 'On' : 'Off'}
                  </Button>
                </Field>
              </Stack>
            </Panel>
            <Panel title="Quality">
              <Segmented<Quality>
                block
                value={quality}
                onChange={setQuality}
                options={[
                  { value: 'good', label: 'Good' },
                  { value: 'high', label: 'High' },
                  { value: 'max', label: 'Max' },
                ]}
              />
              <p className="screc__hint">{BITRATE[quality] / 1_000_000} Mbps · saved as MP4 (H.264 + AAC), which every editor and YouTube accept.</p>
            </Panel>
            <Panel>
              <Button variant="primary" size="lg" block icon={Circle} onClick={start} disabled={!picked || countdown != null}>
                {countdown != null ? `Starting in ${countdown}…` : 'Start recording'}
              </Button>
              <p className="screc__hint">3-second countdown, then everything on that {kind} goes into the file. Come back here to stop.</p>
            </Panel>
          </div>
          {kind === 'window' && <Notice tone="info">Recording one window keeps other windows out, even when they overlap it. Full-screen games are best recorded as a screen.</Notice>}
        </>
      )}

      {recent && recent.files.length > 0 && (
        <Panel
          title="Recent recordings"
          hint={recent.dir}
          actions={
            <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => api.invoke('openFolder')}>
              Open folder
            </Button>
          }
        >
          <div className="screc__recent">
            {recent.files.map((f) => (
              <button key={f.path} type="button" className="screc__file" onClick={() => api.invoke('reveal', { path: f.path })}>
                <span>{f.name}</span>
                <Badge>{formatBytes(f.bytes)}</Badge>
              </button>
            ))}
          </div>
        </Panel>
      )}
    </Stack>
  )
}
