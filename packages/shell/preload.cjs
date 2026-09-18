// The bridge the dashboard page sees as `window.laikaShell`. Runs sandboxed: the page
// only gets these calls, never Node or the Electron APIs. Typed in packages/app/src/shell.d.ts.
const { contextBridge, ipcRenderer } = require('electron')

const invoke = (ch, payload) => ipcRenderer.invoke(ch, payload)
const listen = (ch, cb) => {
  const h = (_e, data) => cb(data)
  ipcRenderer.on(ch, h)
  return () => ipcRenderer.removeListener(ch, h)
}

contextBridge.exposeInMainWorld('laikaShell', {
  ready: true,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome },
  state: () => invoke('shell:state'),
  onState: (cb) => listen('shell:state', cb),
  onCommand: (cb) => listen('shell:cmd', cb),
  onFind: (cb) => listen('shell:find', cb),
  /** stills of the pages on show, taken as page UI covers the dock, to draw under it */
  onFrames: (cb) => listen('shell:frames', cb),
  /** where the active tab's page is drawn, in page pixels; null while the dock is closed */
  setBounds: (rect) => ipcRenderer.send('shell:bounds', rect),
  /** something in the page is drawn over the browser area, so the native view must step aside */
  setCovered: (on) => ipcRenderer.send('shell:covered', !!on),
  /** keyboard focus is inside the browser dock: browser keys (⌘W, ⌘F, ⌘R …) are for it */
  setDockFocus: (on) => ipcRenderer.send('shell:dock-focus', !!on),
  tab: (op, args) => invoke('shell:tab', { op, ...args }),
  profile: (op, args) => invoke('shell:profile', { op, ...args }),
  chromeProfiles: () => invoke('shell:chrome-profiles'),
  /** a download by id: open, show, cancel, retry, remove; or the list: clear, folder */
  download: (op, id) => invoke('shell:download', { op, id }),
  /** a profile's bookmarks: add, update, remove, move, menu; bar (show or hide the bar) */
  bookmark: (op, args) => invoke('shell:bookmark', { op, ...args }),
  /** Chrome extensions of a profile: list, install (Web Store id), remove, chrome (import list), store */
  extensions: (op, args) => invoke('shell:extensions', { op, ...args }),
  /** a part of the app ('claude', 'control') in its own window; on=false puts it back */
  popout: (part, on = true) => invoke('shell:popout', { part, on }),
})
