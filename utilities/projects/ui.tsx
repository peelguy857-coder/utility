import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, FolderOpen, FolderPlus, Play, RefreshCw, Rocket, ScanSearch, Square, Trash2 } from 'lucide-react'
import { core, errorMessage, useBackend, useBackendEvent } from '@/lib/bridge'
import { cx, formatDuration } from '@/lib/format'
import { useToast } from '@/components/Toasts'
import { Badge, Button, Checkbox, Empty, IconButton, Notice, Panel, Row, Select, Stack } from '@/components/ui'
import './ui.css'

interface Project {
  id: string
  path: string
  name: string
  description: string
  scripts: string[]
  script: string
  exists: boolean
  running: boolean
  pid: number | null
  since: number | null
  urls: string[]
}
interface Candidate {
  path: string
  name: string
  scripts: string[]
  script: string
}

export default function Projects() {
  const api = useBackend('projects')
  const toast = useToast()
  const [projects, setProjects] = useState<Project[]>([])
  const [node, setNode] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [logs, setLogs] = useState<Record<string, string[]>>({})
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [clock, setClock] = useState(Date.now())
  const logRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.invoke<{ projects: Project[]; node: string | null }>('list')
      setProjects(res.projects)
      setNode(res.node)
      setSelected((s) => s ?? res.projects[0]?.id ?? null)
    } catch (err) {
      toast.error('Could not load projects', { detail: errorMessage(err) })
    }
  }, [api, toast])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    const t = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  useEffect(() => {
    if (!selected) return
    api.invoke<{ lines: string[] }>('log', { id: selected }).then((r) => setLogs((l) => ({ ...l, [selected]: r.lines }))).catch(() => {})
  }, [selected, api])
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs, selected])

  useBackendEvent<{ id: string; text: string }>('projects', 'log', ({ id, text }) =>
    setLogs((l) => {
      const lines = [...(l[id] || []), ...text.split(/\r?\n/).map((s) => s.trimEnd()).filter(Boolean)]
      return { ...l, [id]: lines.slice(-400) }
    }),
  )
  useBackendEvent<{ id: string; url: string }>('projects', 'url', ({ id, url }) => setProjects((list) => list.map((p) => (p.id === id && !p.urls.includes(url) ? { ...p, urls: [...p.urls, url] } : p))))
  useBackendEvent<{ id: string; code: number | null }>('projects', 'exit', ({ id, code }) => {
    setProjects((list) => list.map((p) => (p.id === id ? { ...p, running: false, pid: null, since: null } : p)))
    const p = projects.find((x) => x.id === id)
    if (code && code !== 0) toast.warn(`${p?.name ?? 'Project'} stopped with an error (code ${code})`, { detail: 'See its log.' })
  })

  const run = async (method: string, args?: unknown) => {
    try {
      const res = await api.invoke<Project[] | { running: boolean } | undefined>(method, args)
      if (Array.isArray(res)) setProjects(res)
      else await load()
    } catch (err) {
      toast.error('That did not work', { detail: errorMessage(err) })
    }
  }

  const addFolder = async () => {
    const folder = await core.pickFolder({ title: 'Choose a project folder (the one with package.json)' })
    if (folder) await run('add', { folder })
  }

  const scan = async () => {
    setScanning(true)
    try {
      const found = await api.invoke<Candidate[]>('scan')
      setCandidates(found)
      setPicked(new Set(found.map((c) => c.path)))
      if (!found.length) toast.info('No new projects found', { detail: 'Looked in Desktop, Desktop\\Files and Documents.' })
    } catch (err) {
      toast.error('Scan failed', { detail: errorMessage(err) })
    } finally {
      setScanning(false)
    }
  }

  const current = useMemo(() => projects.find((p) => p.id === selected) ?? null, [projects, selected])
  const lines = (current && logs[current.id]) || []

  return (
    <Stack gap={16}>
      {!node && <Notice tone="warn" title="Node.js was not found on this PC">Install it from nodejs.org and the projects can be started from here.</Notice>}

      {candidates && candidates.length > 0 && (
        <Panel
          title={`Found ${candidates.length} project${candidates.length === 1 ? '' : 's'}`}
          hint="Tick the ones to add."
          actions={
            <Row gap={6}>
              <Button size="sm" variant="ghost" onClick={() => setCandidates(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={picked.size === 0}
                onClick={async () => {
                  await run('addMany', { folders: [...picked] })
                  setCandidates(null)
                }}
              >
                Add {picked.size}
              </Button>
            </Row>
          }
        >
          <div className="projects__cands">
            {candidates.map((c) => (
              <Checkbox key={c.path} checked={picked.has(c.path)} onChange={(on) => setPicked((s) => { const n = new Set(s); if (on) n.add(c.path); else n.delete(c.path); return n })}>
                <span className="projects__cand">
                  <strong>{c.name}</strong>
                  <span>{c.path}</span>
                </span>
              </Checkbox>
            ))}
          </div>
        </Panel>
      )}

      <div className="projects">
        <Panel
          flush
          title="Projects"
          actions={
            <Row gap={4}>
              <Button size="sm" variant="ghost" icon={ScanSearch} loading={scanning} onClick={scan}>
                Find
              </Button>
              <Button size="sm" icon={FolderPlus} onClick={addFolder}>
                Add folder
              </Button>
            </Row>
          }
        >
          {projects.length === 0 ? (
            <Empty icon={Rocket} title="No projects yet">
              Press Find to look through your Desktop and Documents, or add a folder that has a package.json.
            </Empty>
          ) : (
            <div className="projects__list">
              {projects.map((p) => (
                <button key={p.id} type="button" className={cx('projects__item', p.id === selected && 'is-selected', p.running && 'is-running')} onClick={() => setSelected(p.id)}>
                  <span className={cx('projects__dot', p.running && 'is-on')} />
                  <span className="projects__text">
                    <span className="projects__name">{p.name}</span>
                    <span className="projects__path" title={p.path}>
                      {p.running && p.since ? `running ${formatDuration(clock - p.since)} · npm run ${p.script}` : p.exists ? p.path : 'folder is missing'}
                    </span>
                  </span>
                  {p.running ? (
                    <IconButton
                      icon={Square}
                      label="Stop"
                      onClick={(e) => {
                        e.stopPropagation()
                        void run('stop', { id: p.id })
                      }}
                    />
                  ) : (
                    <IconButton
                      icon={Play}
                      label={`Run npm run ${p.script}`}
                      disabled={!p.exists || !p.script || !node}
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelected(p.id)
                        void run('start', { id: p.id })
                      }}
                    />
                  )}
                </button>
              ))}
            </div>
          )}
        </Panel>

        <Panel flush className="projects__detail">
          {current ? (
            <>
              <div className="projects__head">
                <div className="projects__titles">
                  <h3>
                    {current.name}
                    {current.running ? <Badge tone="ok">running</Badge> : <Badge>stopped</Badge>}
                  </h3>
                  <p>{current.description || current.path}</p>
                </div>
                <Row gap={6} wrap>
                  <Select value={current.script} onChange={(script) => run('setScript', { id: current.id, script })} options={current.scripts.map((s) => ({ value: s, label: `npm run ${s}` }))} disabled={current.running} />
                  {current.running ? (
                    <Button variant="danger" icon={Square} onClick={() => run('stop', { id: current.id })}>
                      Stop
                    </Button>
                  ) : (
                    <Button variant="primary" icon={Play} disabled={!current.exists || !node || !current.script} onClick={() => run('start', { id: current.id })}>
                      Start
                    </Button>
                  )}
                </Row>
              </div>
              <div className="projects__actions">
                {current.urls.map((url) => (
                  <Button key={url} size="sm" icon={ExternalLink} onClick={() => api.invoke('openUrl', { url })}>
                    {url.replace(/^https?:\/\//, '')}
                  </Button>
                ))}
                <span className="projects__spacer" />
                <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => api.invoke('openFolder', { id: current.id })}>
                  Folder
                </Button>
                <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => run('refresh', { id: current.id })}>
                  Re-read scripts
                </Button>
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => run('remove', { id: current.id })}>
                  Remove
                </Button>
              </div>
              <div className="projects__log" ref={logRef}>
                {lines.length === 0 ? <div className="projects__log-empty">{current.running ? 'Waiting for output…' : 'Press Start. The output shows up here, and any localhost link it prints becomes a button above.'}</div> : lines.map((l, i) => <div key={i} className={cx(l.startsWith('> ') && 'is-system')}>{l}</div>)}
              </div>
            </>
          ) : (
            <Empty icon={Rocket} title="Pick a project" />
          )}
        </Panel>
      </div>
    </Stack>
  )
}
