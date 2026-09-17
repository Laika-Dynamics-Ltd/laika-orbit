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
  /** bookmark-edit: the bookmark to edit; absent = the active tab's page */
  id?: string
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
  setBounds(rect: { x: number; y: number; width: number; height: number } | null): void
  setCovered(on: boolean): void
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
