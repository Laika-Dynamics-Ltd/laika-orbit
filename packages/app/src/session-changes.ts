/**
 * The Changes view of a Claude session, in place of VS Code's Source Control: every file
 * changed in the session's repo with its diff, revert per file, and commit selected files.
 * Data comes from /api/control/git/* (control-api.mjs).
 */
import { diffHtml } from './diff.ts'

type FileChange = {
  path: string
  from: string | null
  kind: 'modified' | 'added' | 'deleted' | 'renamed'
  staged: boolean
  untracked: boolean
  added: number
  deleted: number
  binary: boolean
}
type Status = {
  root: string
  branch: string | null
  ahead: number
  behind: number
  files: FileChange[]
}

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[<>&"']/g,
    (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[m] as string,
  )
const WRITE = { 'x-control': '1', 'content-type': 'application/json' }
const LETTER = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R' } as const

export type ChangesView = {
  refresh(): Promise<void>
  count(): number
  el: HTMLElement
}

export function createChangesView(cwd: string, onCount: (n: number) => void): ChangesView {
  const el = document.createElement('div')
  el.className = 'sc'
  let status: Status | null = null
  const open = new Set<string>()
  const skip = new Set<string>() // files unticked for the next commit
  let busy = false
  let note = ''

  async function refresh() {
    try {
      const r = await fetch(`/api/control/git/status?cwd=${encodeURIComponent(cwd)}`)
      const d = await r.json()
      if (!r.ok) {
        status = null
        note = d.error ?? 'Not a git repo'
      } else status = d
    } catch {
      note = 'Could not read git status'
    }
    onCount(status?.files.length ?? 0)
    paint()
  }

  async function diffFor(f: FileChange, box: HTMLElement) {
    if (f.binary) {
      box.innerHTML = '<div class="sc-note">Binary file</div>'
      return
    }
    box.innerHTML = '<div class="sc-note">Loading diff…</div>'
    const d = await fetch(
      `/api/control/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(f.path)}`,
    ).then((r) => r.json())
    if (d.binary) box.innerHTML = '<div class="sc-note">Binary file</div>'
    else if (d.tooBig) box.innerHTML = '<div class="sc-note">Too large to show here</div>'
    else if (d.error) box.innerHTML = `<div class="sc-note err">${esc(d.error)}</div>`
    else box.innerHTML = diffHtml(d.before ?? '', d.after ?? '', f.path, 1500)
  }

  function paint() {
    if (!status) {
      el.innerHTML = `<div class="sc-empty">${esc(note || 'Loading…')}</div>`
      return
    }
    const files = status.files
    const chosen = files.filter((f) => !skip.has(f.path))
    // a refresh while you are writing the commit message must not wipe it
    const typed = el.querySelector<HTMLTextAreaElement>('[data-sc="msg"]')?.value ?? ''
    el.innerHTML = `
      <div class="sc-top">
        <span class="sc-branch">${esc(status.branch ?? 'detached')}</span>
        ${status.ahead ? `<span class="sc-pill warn">${status.ahead} to push</span>` : ''}
        ${status.behind ? `<span class="sc-pill">${status.behind} behind</span>` : ''}
        <span class="sc-count">${files.length ? `${files.length} changed file${files.length === 1 ? '' : 's'}` : 'No changes'}</span>
        <button type="button" class="sc-link" data-sc="refresh">Refresh</button>
      </div>
      ${
        files.length
          ? `<div class="sc-commit">
              <textarea rows="2" placeholder="Commit message" data-sc="msg"></textarea>
              <button type="button" class="sc-btn" data-sc="commit" ${chosen.length ? '' : 'disabled'}>Commit ${chosen.length} file${chosen.length === 1 ? '' : 's'}</button>
            </div>
            ${note ? `<div class="sc-note">${esc(note)}</div>` : ''}`
          : ''
      }
      <ul class="sc-files">${files
        .map((f) => {
          const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : ''
          const name = f.path.slice(dir.length)
          return `<li class="sc-file ${f.kind}${open.has(f.path) ? ' open' : ''}" data-path="${esc(f.path)}">
            <div class="sc-row">
              <input type="checkbox" data-sc="pick" ${skip.has(f.path) ? '' : 'checked'} aria-label="Include ${esc(f.path)} in the commit" />
              <button type="button" class="sc-name" data-sc="toggle"><b>${esc(name)}</b><span>${esc(dir)}</span></button>
              <span class="sc-stat">${f.binary ? 'bin' : `<ins>+${f.added}</ins> <del>−${f.deleted}</del>`}</span>
              <span class="sc-kind" title="${f.kind}">${f.untracked ? 'U' : LETTER[f.kind]}</span>
              <button type="button" class="sc-link danger" data-sc="revert" title="Discard changes to this file">Revert</button>
            </div>
            <div class="sc-diff"></div>
          </li>`
        })
        .join('')}</ul>`
    const msg = el.querySelector<HTMLTextAreaElement>('[data-sc="msg"]')
    if (msg) msg.value = typed
    for (const p of open) {
      const li = el.querySelector<HTMLElement>(`.sc-file[data-path="${CSS.escape(p)}"]`)
      const f = files.find((x) => x.path === p)
      if (li && f) diffFor(f, li.querySelector('.sc-diff') as HTMLElement)
    }
  }

  el.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement
    const act = t.closest<HTMLElement>('[data-sc]')?.dataset.sc
    const li = t.closest<HTMLElement>('.sc-file')
    const path = li?.dataset.path ?? ''
    const f = status?.files.find((x) => x.path === path)
    if (act === 'refresh') return refresh()
    if (act === 'toggle' && li && f) {
      if (open.has(path)) {
        open.delete(path)
        li.classList.remove('open')
      } else {
        open.add(path)
        li.classList.add('open')
        diffFor(f, li.querySelector('.sc-diff') as HTMLElement)
      }
    }
    if (act === 'pick' && f) {
      if ((t as HTMLInputElement).checked) skip.delete(path)
      else skip.add(path)
      const n = (status?.files ?? []).filter((x) => !skip.has(x.path)).length
      const btn = el.querySelector<HTMLButtonElement>('[data-sc="commit"]')
      if (btn) {
        btn.textContent = `Commit ${n} file${n === 1 ? '' : 's'}`
        btn.disabled = !n
      }
    }
    if (act === 'revert' && f && !busy) {
      const what =
        f.untracked || f.kind === 'added'
          ? `Delete the new file ${f.path}?`
          : `Discard all changes to ${f.path}?`
      if (!confirm(`${what} This can't be undone.`)) return
      busy = true
      const r = await fetch('/api/control/git/revert', {
        method: 'POST',
        headers: WRITE,
        body: JSON.stringify({ cwd, path }),
      })
      const d = await r.json()
      busy = false
      note = r.ok ? `Reverted ${path}` : (d.error ?? 'Revert failed')
      if (r.ok) status = d
      open.delete(path)
      onCount(status?.files.length ?? 0)
      paint()
    }
    if (act === 'commit' && !busy) {
      const msg = (el.querySelector('[data-sc="msg"]') as HTMLTextAreaElement).value.trim()
      if (!msg) {
        ;(el.querySelector('[data-sc="msg"]') as HTMLTextAreaElement).focus()
        note = 'Write a commit message first'
        return paint()
      }
      busy = true
      const paths = (status?.files ?? [])
        .filter((x) => !skip.has(x.path))
        .flatMap((x) => (x.from ? [x.path, x.from] : [x.path]))
      const r = await fetch('/api/control/git/commit', {
        method: 'POST',
        headers: WRITE,
        body: JSON.stringify({ cwd, paths, message: msg }),
      })
      const d = await r.json()
      busy = false
      if (r.ok) {
        note = `Committed ${d.hash}`
        status = d.status
        skip.clear()
        open.clear()
      } else note = d.error ?? 'Commit failed'
      onCount(status?.files.length ?? 0)
      paint()
    }
  })

  return { refresh, count: () => status?.files.length ?? 0, el }
}
