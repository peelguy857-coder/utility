// The only bridge between the UI and the main process. Sandboxed + context-isolated:
// the page gets these few functions and nothing else (no Node, no ipcRenderer).
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('utility', {
  platform: process.platform,

  /** Call a core service in the main process, e.g. core('pick-file', {...}). */
  core: (method, ...args) => ipcRenderer.invoke('core:' + method, ...args),

  /** Call a method of a utility's backend (utilities/<id>/main.cjs). */
  invoke: (utilId, method, args) => ipcRenderer.invoke('util:invoke', utilId, method, args),

  /** Listen to events a utility's backend emits. Returns an unsubscribe function. */
  on: (utilId, callback) => {
    const listener = (_e, id, event, payload) => {
      if (id === utilId) callback(event, payload)
    }
    ipcRenderer.on('util:event', listener)
    return () => ipcRenderer.removeListener('util:event', listener)
  },

  /** Commands pushed from the main process (used by the screenshot run). */
  onCommand: (callback) => {
    const listener = (_e, command, payload) => callback(command, payload)
    ipcRenderer.on('core:command', listener)
    return () => ipcRenderer.removeListener('core:command', listener)
  },

  /** Tells the main process the UI has rendered (the screenshot run waits for this). */
  uiReady: (info) => ipcRenderer.send('core:ui-ready', info),

  /** Real path of a dropped File. Also tells the main process the user shared that path. */
  pathForFile: (file) => {
    let p = ''
    try {
      p = webUtils.getPathForFile(file)
    } catch {
      p = ''
    }
    if (p) ipcRenderer.send('core:allow-path', p)
    return p
  },
})
