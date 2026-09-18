/**
 * The bridge the desktop shell (packages/shell) exposes to this page as `window.laikaShell`.
 * Present only when the page runs inside the shell; in a plain browser it is undefined and
 * the browser dock explains how to launch the shell instead.
 */
export type ShellProfile = { id: string; name: string; colour: string }
export type ShellTab = {
  id: string
  profile: string
  /** null for a fresh tab that has not gone anywhere yet (the start page shows) */
  url: string | null
  title: string
  favicon: string | null
  loading: boolean
  audible: boolean
  muted: boolean
  failed: { code: number; desc: string; url: string } | null
  /** the page crashed or was ended (the reason, e.g. 'crashed', 'oom'); null once reloaded */
  gone?: string | null
  /** the page stopped answering */
  hung?: boolean
  /** a permission the page is waiting on you for (camera, location …) */
  ask?: {
    origin: string
    what: string
    text?: string | null
    yes?: string | null
    no?: string | null
  } | null
  /** restored from the last launch; gets a renderer when first activated */
  sleeping: boolean
  /** the tab's webContents id while it has a renderer: extension icons show its state */
  wcId?: number | null
  /** there is history to step to (the renderer's own, so false while sleeping) */
  canGoBack?: boolean
  canGoForward?: boolean
  /** page zoom factor, 1 = 100% */
  zoom?: number
}
export type ShellHistory = {
  url: string
  title: string
  profile: string
  at: number
}
/** two tabs side by side: a on the left, b on the right; ratio is a's share of the width */
export type ShellSplit = { a: string; b: string; ratio: number }
export type ShellRect = { x: number; y: number; width: number; height: number }
export type ShellBookmark = {
  id: string
  url: string
  title: string
  favicon: string | null
}
export type ShellDownload = {
  id: string
  name: string
  path: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  received: number
  total: number
  at: number
  url?: string
  profile?: string
  /** a completed file is still where it was saved */
  exists?: boolean
}
export type ShellState = {
  profiles: ShellProfile[]
  defaultProfile: string
  tabs: ShellTab[]
  active: string | null
  /** absent in an older shell */
  splits?: ShellSplit[]
  history: ShellHistory[]
  downloads: ShellDownload[]
  /** by profile id, in bar order (absent in an older shell) */
  bookmarks?: Record<string, ShellBookmark[]>
  bookmarkBar?: boolean
  dockOpen: boolean
  /** parts of the app open in their own windows ('claude', 'control') */
  popouts?: string[]
  versions: { electron: string; chrome: string }
}
export type ShellCommand = {
  cmd:
    | 'open'
    | 'toggle'
    | 'focus-omnibox'
    | 'find'
    | 'spotlight'
    | 'pick-profile'
    | 'downloads'
    | 'bookmark-edit'
    | 'key'
  /** bookmark-edit: the bookmark to edit; absent = the active tab's page */
  id?: string
  /** key: one of Orbit's own keys, pressed inside a web page */
  code?: string
  key?: string
  alt?: boolean
  meta?: boolean
  ctrl?: boolean
  shift?: boolean
}
export type ShellExtension = {
  id: string
  name: string
  version: string
  description: string
  hasAction: boolean
  nativeMessaging: boolean
}
export type ChromeExtension = {
  id: string
  name: string
  nativeMessaging: boolean
  mv: number
  installed: boolean
}
export type ChromeProfile = {
  dir: string
  name: string
  person: string | null
  colour: string | null
}

export type LaikaShell = {
  ready: true
  versions: { electron: string; chrome: string }
  state(): Promise<ShellState>
  onState(cb: (s: ShellState) => void): () => void
  onCommand(cb: (c: ShellCommand) => void): () => void
  onFind(cb: (r: { tab: string; active: number; total: number }) => void): () => void
  /** stills of the pages on show, sent as page UI covers the dock (newer shells) */
  onFrames?(cb: (frames: { tab: string; src: string }[]) => void): () => void
  /** the dock's view area; in a split, also each pane's, by tab id */
  setBounds(rect: (ShellRect & { panes?: Record<string, ShellRect> }) | null): void
  setCovered(on: boolean): void
  /** keyboard focus is inside the browser dock, so the browser's keys are for it (newer shells) */
  setDockFocus?(on: boolean): void
  tab(op: string, args?: Record<string, unknown>): Promise<unknown>
  profile(op: string, args?: Record<string, unknown>): Promise<unknown>
  chromeProfiles(): Promise<ChromeProfile[]>
  download(
    op: 'open' | 'show' | 'cancel' | 'retry' | 'remove' | 'clear' | 'folder',
    id?: string,
  ): Promise<unknown>
  /** absent in an older shell */
  bookmark?(
    op: 'add' | 'update' | 'remove' | 'move' | 'menu' | 'bar',
    args: Record<string, unknown>,
  ): Promise<unknown>
  /** absent in a shell without extension support */
  extensions?(
    op: 'list' | 'install' | 'remove' | 'chrome' | 'store',
    args?: Record<string, unknown>,
  ): Promise<unknown>
  /** absent in a shell older than pop-outs */
  popout?(part: string, on?: boolean): Promise<unknown>
}

declare global {
  interface Window {
    laikaShell?: LaikaShell
  }
}
