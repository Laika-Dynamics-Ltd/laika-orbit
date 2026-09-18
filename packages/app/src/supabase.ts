import './supabase.css'
import { registerPanel } from './panels.ts'
import { destructive, readOnly } from './sql.ts'

/**
 * The database window (d): every Supabase account you have connected, each project's schema, and
 * a console to run raw SQL at it.
 *
 * An account is a personal access token stored in the Keychain by the server (supabase.mjs); this
 * side only ever names it. Picking an account lists its projects, picking a project reads its
 * schema with one query, and clicking a table writes the select for it — so the common case
 * (look at what is in there) needs no typing at all.
 *
 * Read-only is the default and the server is what enforces it, so a write refused here was never
 * sent. Unlocking writes is per project and does not persist: the toggle is off again next time
 * the window opens, and a destructive statement asks once more in the bar before it runs.
 *
 * Everything the panel remembers is per project and local: which account and project you had
 * open, and the SQL in the editor, so closing the window mid-thought loses nothing.
 */

/** the rail's stack of discs */
const RAIL_ICON =
  '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="10" cy="5" rx="6.4" ry="2.6"/><path d="M3.6 5v10c0 1.44 2.87 2.6 6.4 2.6s6.4-1.16 6.4-2.6V5"/><path d="M3.6 10c0 1.44 2.87 2.6 6.4 2.6s6.4-1.16 6.4-2.6"/></svg>'

export type Supabase = {
  open: () => void
  close: () => void
  toggle: () => void
  isOpen: () => boolean
}

type Account = { label: string; source: 'keychain' | 'env' }
type Project = { ref: string; name: string; region: string | null; status: string | null }
type Column = { name: string; type: string; nullable: boolean }
type Table = { name: string; kind: 'table' | 'view'; columns: Column[] }
type Schema = { name: string; tables: Table[] }
type Result = {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  ms: number
  wrote: boolean
}

const KEY = 'laika.supabase'
/** rows drawn at once; the rest arrive as you scroll, so a 2,000-row result still opens instantly */
const PAGE = 200

type Saved = { account?: string; ref?: string; sql?: Record<string, string> }
const saved = (): Saved => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}
const save = (patch: Saved) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...saved(), ...patch }))
  } catch {}
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const json = init.body ? { ...init, headers: { 'content-type': 'application/json' } } : init
  const r = await fetch(`/api/supabase${path}`, json)
  const body = await r.json().catch(() => null)
  if (!r.ok) throw new Error(body?.error ?? `The app answered ${r.status}`)
  return body as T
}

/** a value in a cell: null is a state, not the text "null", and json stays on one line */
function cell(v: unknown): { text: string; kind: string } {
  if (v === null || v === undefined) return { text: 'null', kind: 'null' }
  if (typeof v === 'boolean') return { text: String(v), kind: 'bool' }
  if (typeof v === 'number') return { text: String(v), kind: 'num' }
  if (typeof v === 'object') return { text: JSON.stringify(v), kind: 'json' }
  return { text: String(v), kind: '' }
}

/** what `select * from` a table should look like, quoted so a reserved word or capital survives */
const qualified = (schema: string, table: string) => `"${schema}"."${table}"`

const SQL_FOR = (schema: string, table: string) =>
  `select *\n  from ${qualified(schema, table)}\n limit 100;`

const ICON = {
  table:
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="12" height="11" rx="1.6"/><path d="M2 6.2h12M6.4 6.2v7.3"/></svg>',
  view: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.6 8s2.4-4.2 6.4-4.2S14.4 8 14.4 8s-2.4 4.2-6.4 4.2S1.6 8 1.6 8Z"/><circle cx="8" cy="8" r="1.8"/></svg>',
}

export function createSupabase(o: { host?: HTMLElement } = {}): Supabase {
  const hosted = !!o.host
  let overlay: HTMLDivElement | null = null
  let accounts: Account[] = []
  let projects: Project[] = []
  let account = ''
  let ref = ''
  /** writes are unlocked per project and never across an open: the set empties when the window does */
  const unlocked = new Set<string>()
  /** a destructive statement waiting on the second yes, kept so the Run button can be it */
  let pending: string | null = null
  let running = false
  let shown = PAGE
  /** whether this machine can store a token at all (macOS); the sheet says so when it cannot */
  let keychain = false

  const el = <T extends HTMLElement>(sel: string) => overlay!.querySelector<T>(sel)!
  const project = () => projects.find((p) => p.ref === ref) ?? null
  const editor = () => el<HTMLTextAreaElement>('.sb-sql')

  // --------------------------------------------------------------- the frame ----

  function build() {
    overlay = document.createElement('div')
    overlay.className = 'sb'
    if (!hosted) overlay.id = 'sb'
    overlay.setAttribute('role', hosted ? 'group' : 'dialog')
    overlay.setAttribute('aria-label', 'Databases')
    overlay.innerHTML = `
      <div class="sb-win">
        <div class="sb-bar">
          <label class="sb-pick"><span>Account</span><select class="sb-acct" aria-label="Supabase account"></select></label>
          <label class="sb-pick"><span>Project</span><select class="sb-proj" aria-label="Project"></select></label>
          <button type="button" class="sb-btn ghost sb-accounts">Accounts</button>
          <button type="button" class="sb-btn ghost sb-details" title="Project details, URL and API keys">Details</button>
          <i class="sb-fill"></i>
          <label class="sb-writes"><input type="checkbox" class="sb-write-on"><span>Allow writes</span></label>
          <button type="button" class="sb-btn sb-run">Run <kbd>⌘↵</kbd></button>
          ${hosted ? '' : '<button type="button" class="sb-btn ghost sb-close" aria-label="Close">×</button>'}
        </div>
        <div class="sb-body">
          <aside class="sb-side" aria-label="Schema"><div class="sb-tree"></div></aside>
          <div class="sb-main">
            <textarea class="sb-sql" spellcheck="false" aria-label="SQL" placeholder="select * from …   —   ⌘↵ runs, read-only until you allow writes"></textarea>
            <div class="sb-note" hidden></div>
            <div class="sb-out"><div class="sb-empty">Pick a table on the left, or write a query.</div></div>
            <div class="sb-status"><span class="sb-stat"></span></div>
          </div>
        </div>
      </div>`
    ;(o.host ?? document.body).appendChild(overlay)
    // single-key shortcuts must not fire while you are typing SQL; in a panel, Escape still goes
    // on to the panel frame, which closes it
    overlay.addEventListener('keydown', (e) => {
      if (!(hosted && e.key === 'Escape')) e.stopPropagation()
    })
    if (!hosted) el('.sb-close').addEventListener('click', close)
    el('.sb-run').addEventListener('click', () => void run())
    el('.sb-accounts').addEventListener('click', () => void openAccounts())
    el('.sb-details').addEventListener('click', () => void openDetails())
    el<HTMLSelectElement>('.sb-acct').addEventListener('change', (e) => {
      account = (e.target as HTMLSelectElement).value
      save({ account })
      void loadProjects()
    })
    el<HTMLSelectElement>('.sb-proj').addEventListener('change', (e) => {
      ref = (e.target as HTMLSelectElement).value
      save({ ref })
      void loadSchema()
      paintWrites()
      editor().value = saved().sql?.[ref] ?? ''
    })
    el<HTMLInputElement>('.sb-write-on').addEventListener('change', (e) => {
      const on = (e.target as HTMLInputElement).checked
      on ? unlocked.add(ref) : unlocked.delete(ref)
      pending = null
      paintWrites()
    })
    editor().addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void run()
      }
    })
    editor().addEventListener('input', () => {
      // a changed statement is a different question: the destructive yes does not carry over
      pending = null
      note(null)
      if (ref) save({ sql: { ...saved().sql, [ref]: editor().value } })
    })
    el('.sb-tree').addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      const head = t.closest<HTMLElement>('.sb-schema-head')
      if (head) return void head.parentElement?.classList.toggle('shut')
      const row = t.closest<HTMLElement>('.sb-table')
      if (!row) return
      const { schema, table } = row.dataset
      if (!schema || !table) return
      if (t.closest('.sb-cols-btn')) return void row.classList.toggle('open')
      editor().value = SQL_FOR(schema, table)
      save({ sql: { ...saved().sql, [ref]: editor().value } })
      void run()
    })
    el('.sb-out').addEventListener('scroll', () => {
      const out = el('.sb-out')
      if (out.scrollTop + out.clientHeight > out.scrollHeight - 400) more()
    })
  }

  // --------------------------------------------------------------- accounts ----

  async function loadAccounts() {
    try {
      const r = await api<{ available: boolean; keychain: boolean; accounts: Account[] }>(
        '/accounts',
      )
      accounts = r.accounts
      const sel = el<HTMLSelectElement>('.sb-acct')
      sel.innerHTML = accounts
        .map(
          (a) =>
            `<option value="${a.label}">${a.label}${a.source === 'env' ? ' (env)' : ''}</option>`,
        )
        .join('')
      keychain = r.keychain
      if (!accounts.length) {
        sel.innerHTML = '<option value="">none yet</option>'
        return firstRun(r.keychain)
      }
      // the account you had open, if it is still connected; otherwise the first one
      account = accounts.find((a) => a.label === saved().account)?.label ?? accounts[0]?.label ?? ''
      sel.value = account
      await loadProjects()
    } catch (e) {
      note(`Could not read your accounts: ${(e as Error).message}`, true)
    }
  }

  /** nothing connected yet: what a token is, where it comes from, and the field to paste it into */
  function firstRun(keychain: boolean) {
    tree('<div class="sb-loading">no account connected</div>')
    el('.sb-out').innerHTML = `
      <div class="sb-first">
        <h2>Connect a Supabase account</h2>
        <p>A <b>personal access token</b> lets this window list that account's projects, read their
        schemas and run SQL against them. Make one at
        <a href="https://supabase.com/dashboard/account/tokens" target="_blank" rel="noreferrer">supabase.com → Account → Access Tokens</a>,
        then add it here. ${keychain ? 'It is stored in your macOS Keychain and never reaches this page again.' : 'Without macOS there is no Keychain: set <code>SUPABASE_ACCESS_TOKEN</code> before starting the app instead.'}</p>
        <p class="sb-warn">A token can reach every project on the account, and SQL run here has full rights on the database. Connect accounts you own.</p>
        ${keychain ? '<button type="button" class="sb-btn sb-add">Add an account</button>' : ''}
      </div>`
    el('.sb-out')
      .querySelector('.sb-add')
      ?.addEventListener('click', () => void openAccounts(true))
  }

  // --------------------------------------------------------------- accounts ----

  /**
   * The accounts sheet: every connected account, what each one can see, and the four things you
   * ever want to do to one — add, rename, replace its token, forget it.
   *
   * The organisations and project counts are asked for per account and are allowed to fail: an
   * expired token should show as "could not read", not stop the sheet from opening.
   */
  async function openAccounts(adding = false) {
    const sheet = openSheet('Supabase accounts')
    sheet.body.innerHTML = accounts.length
      ? `<ul class="sb-accts">${accounts
          .map(
            (a) => `
        <li data-acct="${a.label}"${a.label === account ? ' class="on"' : ''}>
          <div class="sb-acct-row">
            <b>${a.label}</b>
            ${a.source === 'env' ? '<i class="sb-tag">env</i>' : '<i class="sb-tag">keychain</i>'}
            ${a.label === account ? '<i class="sb-tag on">open</i>' : ''}
            <span class="sb-acct-what">…</span>
            <span class="sb-fill"></span>
            <button type="button" class="sb-mini" data-do="use">Open</button>
            <button type="button" class="sb-mini" data-do="rename"${a.source === 'env' ? ' disabled' : ''}>Rename</button>
            <button type="button" class="sb-mini" data-do="replace"${a.source === 'env' ? ' disabled' : ''}>Replace token</button>
            <button type="button" class="sb-mini bad" data-do="forget"${a.source === 'env' ? ' disabled' : ''}>Forget</button>
          </div>
        </li>`,
          )
          .join('')}</ul>`
      : '<p class="sb-sheet-empty">No accounts connected yet.</p>'
    sheet.body.insertAdjacentHTML(
      'beforeend',
      keychain
        ? '<button type="button" class="sb-btn sb-add-open">Add an account</button>'
        : '<p class="sb-sheet-empty">Storing tokens needs the macOS Keychain. Elsewhere, set <code>SUPABASE_ACCESS_TOKEN</code> before starting the app.</p>',
    )
    sheet.body.querySelector('.sb-add-open')?.addEventListener('click', () => addForm(sheet))
    if (adding || !accounts.length) addForm(sheet)

    // what each account can see, filled in as the answers arrive
    for (const a of accounts) {
      const where = sheet.body.querySelector<HTMLElement>(
        `[data-acct="${CSS.escape(a.label)}"] .sb-acct-what`,
      )
      if (!where) continue
      void (async () => {
        try {
          const [o, p] = await Promise.all([
            api<{ orgs: { name: string }[] }>(`/orgs?account=${encodeURIComponent(a.label)}`),
            api<{ projects: Project[] }>(`/projects?account=${encodeURIComponent(a.label)}`),
          ])
          const orgs = o.orgs.map((x) => x.name).join(', ')
          where.textContent = `${p.projects.length} ${p.projects.length === 1 ? 'project' : 'projects'}${orgs ? ` · ${orgs}` : ''}`
        } catch (e) {
          where.textContent = (e as Error).message
          where.classList.add('sb-bad')
        }
      })()
    }

    sheet.body.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-do]')
      const label = btn?.closest<HTMLElement>('[data-acct]')?.dataset.acct
      if (!btn || !label) return
      const act = btn.dataset.do
      try {
        if (act === 'use') {
          account = label
          save({ account })
          el<HTMLSelectElement>('.sb-acct').value = label
          closeSheet()
          return void loadProjects()
        }
        if (act === 'rename') {
          const to = prompt(`Rename "${label}" to:`, label)?.trim()
          if (!to || to === label) return
          await api(`/accounts/${encodeURIComponent(label)}`, {
            method: 'PATCH',
            body: JSON.stringify({ label: to }),
          })
          if (account === label) save({ account: to })
          await loadAccounts()
          return void openAccounts()
        }
        if (act === 'replace') return addForm(sheet, label)
        if (act === 'forget') {
          if (
            !confirm(
              `Forget "${label}"? The token leaves your Keychain; the databases are untouched.`,
            )
          )
            return
          await api(`/accounts/${encodeURIComponent(label)}`, { method: 'DELETE' })
          if (account === label) {
            save({ account: '', ref: '' })
            projects = []
            ref = ''
          }
          await loadAccounts()
          return void openAccounts()
        }
      } catch (err) {
        sheet.say((err as Error).message, true)
      }
    })
  }

  /** add an account, or put a fresh token on one that already exists (same call, same field) */
  function addForm(sheet: Sheet, existing?: string) {
    const form = document.createElement('form')
    form.className = 'sb-form sb-form-sheet'
    form.innerHTML = `
      <input class="sb-label" placeholder="label, e.g. laika" aria-label="Account label" autocomplete="off" spellcheck="false" value="${existing ?? ''}"${existing ? ' readonly' : ''}>
      <input class="sb-token" type="password" placeholder="sbp_… personal access token" aria-label="Personal access token" autocomplete="off">
      <button type="submit" class="sb-btn">${existing ? 'Replace' : 'Save'}</button>
      <button type="button" class="sb-btn ghost sb-cancel">Cancel</button>`
    sheet.body.append(form)
    form.querySelector<HTMLInputElement>(existing ? '.sb-token' : '.sb-label')!.focus()
    form.querySelector('.sb-cancel')!.addEventListener('click', () => form.remove())
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const label = form.querySelector<HTMLInputElement>('.sb-label')!.value.trim()
      const token = form.querySelector<HTMLInputElement>('.sb-token')!.value.trim()
      try {
        await api('/accounts', { method: 'POST', body: JSON.stringify({ label, token }) })
        if (!existing) save({ account: label })
        await loadAccounts()
        openAccounts()
      } catch (err) {
        sheet.say((err as Error).message, true)
      }
    })
  }

  /** one project: where it runs, the URL its clients use, and its keys — hidden until asked for */
  async function openDetails() {
    if (!ref) return note('Pick a project first.', true)
    const sheet = openSheet(project()?.name ?? 'Project')
    sheet.body.innerHTML = '<p class="sb-sheet-empty">reading…</p>'
    try {
      const d = await api<
        Project & { url: string; dashboard: string; keys: { name: string; key: string }[] }
      >(`/project?account=${encodeURIComponent(account)}&ref=${encodeURIComponent(ref)}`)
      sheet.body.innerHTML = `
        <dl class="sb-facts">
          <dt>Reference</dt><dd><code>${d.ref}</code><button type="button" class="sb-mini" data-copy="${d.ref}">Copy</button></dd>
          <dt>Region</dt><dd>${d.region ?? '—'}</dd>
          <dt>Status</dt><dd>${(d.status ?? '—').toString().toLowerCase().replace(/_/g, ' ')}</dd>
          <dt>Project URL</dt><dd><code>${d.url}</code><button type="button" class="sb-mini" data-copy="${d.url}">Copy</button></dd>
          <dt>Dashboard</dt><dd><a href="${d.dashboard}" target="_blank" rel="noreferrer">open on supabase.com</a></dd>
        </dl>
        <h3 class="sb-sub">API keys</h3>
        ${
          d.keys.length
            ? `<ul class="sb-keys">${d.keys
                .map(
                  (k) => `<li${/service/.test(k.name) ? ' class="bad"' : ''}>
                    <b>${k.name}</b><code class="sb-key" data-key="${k.key}">${'•'.repeat(28)}</code>
                    <button type="button" class="sb-mini" data-reveal>Reveal</button>
                    <button type="button" class="sb-mini" data-copy="${k.key}">Copy</button>
                  </li>`,
                )
                .join('')}</ul>
               <p class="sb-sheet-empty">A <code>service_role</code> key bypasses row-level security. Treat it like the database password.</p>`
            : '<p class="sb-sheet-empty">This token cannot read the project\u2019s keys.</p>'
        }`
      sheet.body.addEventListener('click', (e) => {
        const t = e.target as HTMLElement
        const copy = t.closest<HTMLElement>('[data-copy]')?.dataset.copy
        if (copy) {
          void navigator.clipboard.writeText(copy)
          return sheet.say('copied')
        }
        if (t.closest('[data-reveal]')) {
          const code = t.closest('li')?.querySelector<HTMLElement>('.sb-key')
          if (code?.dataset.key)
            code.textContent = code.textContent?.startsWith('•') ? code.dataset.key : '•'.repeat(28)
        }
      })
    } catch (e) {
      sheet.body.innerHTML = ''
      sheet.say((e as Error).message, true)
    }
  }

  // --------------------------------------------------------------- the sheet ----

  type Sheet = { body: HTMLElement; say: (text: string, bad?: boolean) => void }
  let sheetEl: HTMLElement | null = null

  /** a card over the window for the things that are not the console itself */
  function openSheet(title: string): Sheet {
    closeSheet()
    sheetEl = document.createElement('div')
    sheetEl.className = 'sb-sheet'
    sheetEl.innerHTML = `
      <div class="sb-sheet-card" role="dialog" aria-label="${title}">
        <div class="sb-sheet-head"><h2>${title}</h2><button type="button" class="sb-btn ghost sb-sheet-x" aria-label="Close">×</button></div>
        <div class="sb-sheet-body"></div>
        <div class="sb-sheet-say" hidden></div>
      </div>`
    overlay!.append(sheetEl)
    sheetEl.addEventListener('click', (e) => {
      if (e.target === sheetEl || (e.target as HTMLElement).closest('.sb-sheet-x')) closeSheet()
    })
    const say = sheetEl.querySelector<HTMLElement>('.sb-sheet-say')!
    return {
      body: sheetEl.querySelector<HTMLElement>('.sb-sheet-body')!,
      say: (text: string, bad = false) => {
        say.hidden = false
        say.textContent = text
        say.classList.toggle('sb-bad', bad)
      },
    }
  }

  function closeSheet() {
    sheetEl?.remove()
    sheetEl = null
  }

  // --------------------------------------------------------------- projects and schema ----

  async function loadProjects() {
    const sel = el<HTMLSelectElement>('.sb-proj')
    sel.innerHTML = '<option>loading…</option>'
    try {
      const r = await api<{ projects: Project[] }>(
        `/projects?account=${encodeURIComponent(account)}`,
      )
      projects = r.projects
      if (!projects.length) {
        sel.innerHTML = '<option value="">no projects</option>'
        tree('')
        return note(`"${account}" has no projects.`)
      }
      sel.innerHTML = projects
        .map(
          (p) =>
            `<option value="${p.ref}">${p.name}${p.status && p.status !== 'ACTIVE_HEALTHY' ? ` · ${String(p.status).toLowerCase().replace(/_/g, ' ')}` : ''}</option>`,
        )
        .join('')
      // likewise the project: the one you were in, else this account's first
      ref = projects.find((p) => p.ref === saved().ref)?.ref ?? projects[0]?.ref ?? ''
      sel.value = ref
      save({ ref })
      editor().value = saved().sql?.[ref] ?? ''
      note(null)
      paintWrites()
      await loadSchema()
    } catch (e) {
      sel.innerHTML = '<option value="">—</option>'
      note((e as Error).message, true)
    }
  }

  async function loadSchema() {
    if (!ref) return
    tree('<div class="sb-loading">reading the schema…</div>')
    try {
      const r = await api<{ schemas: Schema[] }>(
        `/schema?account=${encodeURIComponent(account)}&ref=${encodeURIComponent(ref)}`,
      )
      if (!r.schemas.length) return tree('<div class="sb-loading">no tables yet</div>')
      tree(
        r.schemas
          .map(
            (s) => `
        <section class="sb-schema${s.name === 'public' ? '' : ' shut'}">
          <button type="button" class="sb-schema-head"><span class="sb-caret"></span>${s.name}<b>${s.tables.length}</b></button>
          <div class="sb-tables">${s.tables
            .map(
              (t) => `
            <div class="sb-table" data-schema="${s.name}" data-table="${t.name}">
              <div class="sb-table-row">
                <span class="sb-ico">${ICON[t.kind]}</span>
                <span class="sb-name" title="${t.name}">${t.name}</span>
                <button type="button" class="sb-cols-btn" aria-label="Columns of ${t.name}">${t.columns.length}</button>
              </div>
              <ul class="sb-cols">${t.columns
                .map(
                  (c) =>
                    `<li><span>${c.name}</span><i>${c.type}${c.nullable ? '' : ' ·notnull'}</i></li>`,
                )
                .join('')}</ul>
            </div>`,
            )
            .join('')}</div>
        </section>`,
          )
          .join(''),
      )
    } catch (e) {
      tree(`<div class="sb-loading sb-bad">${(e as Error).message}</div>`)
    }
  }

  const tree = (html: string) => {
    el('.sb-tree').innerHTML = html
  }

  // --------------------------------------------------------------- running ----

  function paintWrites() {
    const on = unlocked.has(ref)
    el<HTMLInputElement>('.sb-write-on').checked = on
    overlay!.classList.toggle('writes', on)
  }

  function note(text: string | null, bad = false) {
    const n = el('.sb-note')
    n.hidden = !text
    n.className = `sb-note${bad ? ' sb-bad' : ''}`
    n.textContent = text ?? ''
  }

  /** the destructive second yes: the bar says what will run, and Run again is the answer */
  function ask(what: string, sql: string) {
    pending = sql
    note(`${what} on ${project()?.name ?? 'this project'}. Press Run again to go ahead.`, true)
    el('.sb-run').classList.add('danger')
  }

  async function run() {
    const sql = editor().value.trim()
    if (!sql || !ref || running) return
    const writes = unlocked.has(ref)
    if (!writes && !readOnly(sql)) {
      return note(
        `Read-only. Tick “Allow writes” to run this against ${project()?.name ?? 'the project'}.`,
        true,
      )
    }
    const risky = writes ? destructive(sql) : null
    if (risky && pending !== sql) return ask(risky, sql)
    pending = null
    el('.sb-run').classList.remove('danger')
    running = true
    overlay!.classList.add('busy')
    note(null)
    el('.sb-stat').textContent = 'running…'
    try {
      const r = await api<Result>('/query', {
        method: 'POST',
        body: JSON.stringify({ account, ref, sql, allowWrites: writes }),
      })
      draw(r)
    } catch (e) {
      el('.sb-out').innerHTML = ''
      el('.sb-stat').textContent = ''
      note((e as Error).message, true)
    } finally {
      running = false
      overlay!.classList.remove('busy')
    }
  }

  let rows: Record<string, unknown>[] = []
  let columns: string[] = []

  function draw(r: Result) {
    rows = r.rows
    columns = r.columns
    shown = 0
    const out = el('.sb-out')
    if (!columns.length) {
      out.innerHTML = `<div class="sb-empty">${r.wrote ? 'Done. Nothing was returned.' : 'No rows.'}</div>`
    } else {
      out.innerHTML = `<table class="sb-grid"><thead><tr>${columns.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody></tbody></table>`
      more()
    }
    out.scrollTop = 0
    const n = r.rowCount
    el('.sb-stat').textContent =
      `${n} ${n === 1 ? 'row' : 'rows'}${r.truncated ? ` (first ${r.rows.length} shown)` : ''} · ${r.ms} ms${r.wrote ? ' · wrote' : ''}`
  }

  /** the next page of rows into the open table, which is what keeps a big result from janking */
  function more() {
    if (shown >= rows.length) return
    const body = overlay!.querySelector('.sb-grid tbody')
    if (!body) return
    const frag = document.createDocumentFragment()
    for (const row of rows.slice(shown, shown + PAGE)) {
      const tr = document.createElement('tr')
      for (const c of columns) {
        const td = document.createElement('td')
        const { text, kind } = cell(row?.[c])
        if (kind) td.className = `sb-${kind}`
        td.textContent = text
        td.title = text.length > 80 ? text : ''
        tr.append(td)
      }
      frag.append(tr)
    }
    body.append(frag)
    shown += PAGE
  }

  // --------------------------------------------------------------- open and close ----

  const isOpen = () => overlay?.classList.contains('on') ?? false
  const announce = () => dispatchEvent(new CustomEvent('laika:supabase-open', { detail: isOpen() }))

  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !isOpen()) return
    // a sheet is the thing on top: Escape closes that first, the window next
    if (sheetEl) {
      e.stopImmediatePropagation()
      return closeSheet()
    }
    // in a panel, closing the window is the panel's Escape, not ours
    if (hosted) return
    e.stopImmediatePropagation()
    close()
  }

  function open() {
    if (!overlay) {
      build()
      void loadAccounts()
    }
    overlay!.classList.add('on')
    addEventListener('keydown', onKey, true)
    editor().focus()
    announce()
    dispatchEvent(new CustomEvent('laika:databases-open', { detail: true }))
  }

  function close() {
    if (!overlay) return
    closeSheet()
    overlay.classList.remove('on')
    removeEventListener('keydown', onKey, true)
    // writes are unlocked for as long as the window is open, and no longer
    unlocked.clear()
    pending = null
    paintWrites()
    el('.sb-run').classList.remove('danger')
    announce()
  }

  return { open, close, toggle: () => (isOpen() ? close() : open()), isOpen }
}

// ------------------------------------------------------------------- as a panel ----

/**
 * The databases in the dock: `t`, the rail's Data button, or "Databases" in the palette. Wide,
 * because the schema tree, the editor and a result table are three columns of real content.
 */
export function registerDatabasesPanel() {
  let db: Supabase | null = null
  return registerPanel({
    id: 'databases',
    title: 'Data',
    group: 'know',
    key: 't',
    icon: RAIL_ICON,
    wide: true,
    width: { min: 560, default: 1000, snaps: [720, 1000, 1320] },
    terms: 'databases supabase sql postgres query table schema rows select accounts projects',
    hint: 'Supabase projects, their schemas and raw SQL',
    mount: (host) => {
      db = createSupabase({ host })
      return () => db?.close()
    },
    // the window unlocks writes only while it is open, so closing the panel really closes it
    onVisible: (on) => (on ? db?.open() : db?.close()),
  })
}
