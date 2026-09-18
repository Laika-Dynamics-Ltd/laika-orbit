/**
 * A stand-in for the desktop shell's bridge (`window.laikaShell`, packages/shell/preload.cjs),
 * for the browser dock's page side in a plain browser: tabs are plain records, state goes out
 * the way the shell sends it. Passed to openApp({ init: shellStub }); drive it through
 * `window.__stub` (st: the state, push(): send it again).
 */
export function shellStub() {
  let n = 1
  const st = {
    profiles: [{ id: 'p1', name: 'Personal', colour: '#5b9dff' }],
    defaultProfile: 'p1',
    tabs: [],
    active: null,
    splits: [],
    history: [],
    bookmarks: {},
    bookmarkBar: false,
    downloads: [],
    dockOpen: false,
    popouts: [],
  }
  const subs = []
  const push = () => setTimeout(() => subs.forEach((f) => f(JSON.parse(JSON.stringify(st)))))
  const tab = (profile, url) => ({ id: String(n++), profile, url: url ?? null, title: url ? new URL(url).host : '', favicon: null, loading: false, audible: false, muted: false, failed: null, opener: null, zoom: 1, sleeping: false, wcId: null, canGoBack: false, canGoForward: false })
  const calls = []
  window.__stub = { st, push, calls }
  window.laikaShell = {
    ready: true,
    versions: {},
    state: async () => JSON.parse(JSON.stringify(st)),
    onState: (f) => subs.push(f),
    onCommand: () => {},
    onFind: () => {},
    setBounds: (r) => {
      st.dockOpen = !!r
    },
    setCovered: () => {},
    tab: async (op, a = {}) => {
      calls.push([op, a.id ?? null])
      const i = st.tabs.findIndex((t) => t.id === a.id)
      if (op === 'open') {
        const t = tab(a.profile ?? 'p1', a.url)
        st.tabs.push(t)
        if (a.activate !== false || !st.active) st.active = t.id
        push()
        return t.id
      }
      if (op === 'close' && i >= 0) {
        st.tabs.splice(i, 1)
        if (st.active === a.id) st.active = (st.tabs[i] ?? st.tabs[i - 1])?.id ?? null
        push()
      }
      if (op === 'activate' && i >= 0) {
        st.active = a.id
        push()
      }
    },
    profile: async () => true,
    chromeProfiles: async () => [],
    download: async () => {},
    popout: async () => true,
  }
}
