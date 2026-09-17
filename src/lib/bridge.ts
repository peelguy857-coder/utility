// Typed access to what electron/preload.cjs exposes as window.utility.
import { useEffect, useMemo, useRef } from 'react'
import type { AppInfo, AppSettings, FileFilter, FileInfo } from './types'

interface RawBridge {
  platform: string
  core: (method: string, ...args: unknown[]) => Promise<unknown>
  invoke: (utilId: string, method: string, args?: unknown) => Promise<unknown>
  on: (utilId: string, cb: (event: string, payload: unknown) => void) => () => void
  onCommand: (cb: (command: string, payload: unknown) => void) => () => void
  uiReady: (info: unknown) => void
  pathForFile: (file: File) => string
}

export interface NetworkProblem {
  id: string
  title: string
  detail: string
  action?: { label: string; url: string }
}

export interface NetworkCheck {
  hostname: string
  networks: Array<{ name: string; adapter: string; category: string }>
  problems: NetworkProblem[]
}

declare global {
  interface Window {
    utility?: RawBridge
  }
}

/** False when the UI is opened in a plain browser (no Electron around it). */
export const hasBridge = typeof window !== 'undefined' && !!window.utility

function raw(): RawBridge {
  if (!window.utility) throw new Error('This only works inside the Utility app')
  return window.utility
}

export const core = {
  appInfo: () => raw().core('app-info') as Promise<AppInfo>,
  getSettings: () => raw().core('settings-get') as Promise<AppSettings>,
  setSettings: (patch: Partial<AppSettings>) => raw().core('settings-set', patch) as Promise<AppSettings>,
  getUtilSettings: <T extends object>(id: string) => raw().core('util-settings-get', id) as Promise<Partial<T>>,
  setUtilSettings: <T extends object>(id: string, patch: Partial<T>) => raw().core('util-settings-set', id, patch) as Promise<Partial<T>>,

  pickFile: (opts?: { title?: string; filters?: FileFilter[]; multi?: boolean; defaultPath?: string }) =>
    raw().core('pick-file', opts) as Promise<string[]>,
  pickFolder: (opts?: { title?: string; defaultPath?: string }) => raw().core('pick-folder', opts) as Promise<string | null>,
  saveFile: (opts?: { title?: string; defaultPath?: string; filters?: FileFilter[] }) =>
    raw().core('save-file', opts) as Promise<string | null>,

  fileInfo: (path: string) => raw().core('file-info', path) as Promise<FileInfo>,
  readFile: (path: string) => raw().core('read-file', path) as Promise<Uint8Array>,
  writeFile: (path: string, data: Uint8Array | ArrayBuffer) => raw().core('write-file', { path, data }) as Promise<{ path: string; bytes: number }>,

  reveal: (path: string) => raw().core('reveal', path) as Promise<void>,
  openPath: (path: string) => raw().core('open-path', path) as Promise<string>,
  openExternal: (url: string) => raw().core('open-external', url) as Promise<void>,
  copyText: (text: string) => raw().core('clipboard-write', { text }) as Promise<void>,
  copyImage: (imageDataUrl: string) => raw().core('clipboard-write', { imageDataUrl }) as Promise<void>,
  readClipboard: () => raw().core('clipboard-read') as Promise<string>,

  /** Read-only look at why a phone might not reach this PC (Public network profile, third-party firewall). */
  networkCheck: (fresh = false) => raw().core('network-check', { fresh }) as Promise<NetworkCheck>,

  pathForFile: (file: File) => raw().pathForFile(file),
  onCommand: (cb: (command: string, payload: unknown) => void) => raw().onCommand(cb),
  uiReady: (info: unknown) => raw().uiReady(info),
}

export interface Backend {
  /** Call a handler in utilities/<id>/main.cjs. */
  invoke: <T = unknown>(method: string, args?: unknown) => Promise<T>
  /** Subscribe to everything the backend emits. Returns unsubscribe. */
  subscribe: (cb: (event: string, payload: unknown) => void) => () => void
}

export function backend(id: string): Backend {
  return {
    invoke: <T,>(method: string, args?: unknown) => raw().invoke(id, method, args) as Promise<T>,
    subscribe: (cb) => raw().on(id, cb),
  }
}

/** Stable backend handle for a utility component. */
export function useBackend(id: string): Backend {
  return useMemo(() => backend(id), [id])
}

/** Run `handler` for every event named `event` from this utility's backend. */
export function useBackendEvent<T = unknown>(id: string, event: string, handler: (payload: T) => void) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    if (!hasBridge) return
    return backend(id).subscribe((name, payload) => {
      if (name === event) ref.current(payload as T)
    })
  }, [id, event])
}

/** Turn a caught error into a message fit for a toast (strips Electron's IPC prefix). */
export function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
