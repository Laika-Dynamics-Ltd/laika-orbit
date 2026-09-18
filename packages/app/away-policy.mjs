/**
 * What a chat may do without you while you are away.
 *
 * Away mode (away.mjs) keeps chats moving for hours; a permission prompt nobody answers stalls a
 * chat all afternoon. So while away, and only then, each prompt is first put to `decide`: a
 * conservative, default-deny policy that approves the plainly harmless (reading and editing
 * inside the chat's own folder, running its tests, looking at git) and passes everything else to
 * you as usual, where the conductor reports it. Questions (AskUserQuestion) never come here.
 *
 * The policy is data: ~/.laika/away-policy.json (written the first time away mode starts) widens
 * or narrows the allowlists. Its `read`, `write` and `bash` lists are added to the defaults, and
 * `removed` takes defaults out, so a new safe default reaches everyone without editing the file
 * (a file from before, holding a full copy of the old defaults, still works). Some things no file can switch on: the web,
 * MCP tools, chained or redirected shell commands (the one exception: a leading `cd` into the
 * chat's own folder, then `&&`-joined commands each allowed on its own), and anything that pushes,
 * deploys, deletes or reaches another machine.
 *
 * Every decision the policy makes is appended to ~/.laika/away-log.jsonl.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const DEFAULT_POLICY = Object.freeze({
  version: 1,
  /** read-only tools, for paths inside the chat's folder */
  read: ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'],
  /** editing tools, for paths inside the chat's folder and outside .git and Claude's own settings */
  write: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'],
  /** shell commands, as the words they start with; see bashRules for what may follow */
  bash: [
    'pnpm test',
    'pnpm typecheck',
    'pnpm lint',
    'pnpm build',
    'pnpm run test',
    'pnpm run typecheck',
    'pnpm run lint',
    'pnpm run build',
    'npm test',
    'npm run test',
    'npx vitest',
    'npx tsc --noEmit',
    'node --test',
    'git status',
    'git diff',
    'git log',
    'git show',
    'git branch',
    'git rev-parse',
    // the one place exec runs: these tools, read-only (see EXEC_TOOLS)
    'pnpm exec vitest',
    'pnpm exec tsc --noEmit',
    'pnpm exec biome check',
    'pnpm exec eslint',
    'npx biome check',
    'cargo test',
    'cargo check',
    'cargo clippy',
    'cargo build',
    'make test',
    'make check',
    'make lint',
    'go test',
    'go vet',
    'go build',
    'pytest',
    'python -m pytest',
    'python3 -m pytest',
    'swift test',
    'swift build',
  ],
  recovery: {
    /** a chat running with no events this long is interrupted and told to continue */
    stallMinutes: 20,
    /** at most this many of those nudges per chat, per time away */
    maxNudges: 3,
    /** waits before bringing back a chat that failed, one per attempt */
    backoffMinutes: [1, 5, 15, 30],
    /** a chat stopped by a usage limit moves to another of your own signed-in accounts */
    switchAccounts: true,
  },
})

/** where the editable policy lives (a test points it elsewhere) */
export const policyFile = () => process.env.LAIKA_AWAY_POLICY ?? join(homedir(), '.laika', 'away-policy.json')
/** the audit log (a test points it elsewhere) */
export const logFile = () => process.env.LAIKA_AWAY_LOG ?? join(homedir(), '.laika', 'away-log.jsonl')

const strings = (v, fallback) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : fallback)
const num = (v, fallback, lo, hi) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback)

/** the policy in force: the file where it says something valid, the defaults everywhere else */
export function loadPolicy(file = policyFile()) {
  let raw = null
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {}
  return normalisePolicy(raw)
}

/** a budget as the file holds it: { dollars?, spawns? }, or null for no limit */
const budgetOf = (b) => {
  if (!b || typeof b !== 'object') return null
  const out = {}
  if (Number.isFinite(b.dollars) && b.dollars > 0) out.dollars = Math.round(b.dollars * 100) / 100
  if (Number.isInteger(b.spawns) && b.spawns >= 0) out.spawns = b.spawns
  return Object.keys(out).length ? out : null
}

/**
 * Per-repo overrides: shell commands allowed in one repo and nowhere else, keyed by its folder
 * name. A repo entry can only widen that repo's shell allowlist, or take one of the shared
 * entries back out of it. It can never reach the protected paths, the web or MCP tools, and it
 * can never touch another repo — so a repo you trust with `pnpm deploy:preview` stays the only
 * place that runs it.
 */
const repoOverrides = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [repo, v] of Object.entries(raw)) {
    const name = String(repo).trim()
    if (!name || !v || typeof v !== 'object') continue
    const bash = strings(v.bash, [])
    const gone = strings(v.removed?.bash, [])
    if (bash.length || gone.length) out[name] = { bash, removed: { bash: gone } }
  }
  return out
}

/** the folder name a per-repo override is keyed by */
export const repoKey = (session) => String(session?.repo || String(session?.cwd ?? '').split('/').filter(Boolean).pop() || '')

/**
 * The policy in force for one chat: the shared lists, plus whatever its own repo allows. Only the
 * shell allowlist is per-repo; everything else is the same everywhere, so no repo file can widen
 * what may be read, written or reached.
 */
export function policyFor(policy, session) {
  const r = policy?.repos?.[repoKey(session)]
  if (!r) return policy
  const gone = new Set(r.removed?.bash ?? [])
  return { ...policy, bash: [...new Set([...(policy.bash ?? []), ...(r.bash ?? [])])].filter((x) => !gone.has(x)) }
}

export function normalisePolicy(input) {
  const d = DEFAULT_POLICY
  // no file, or one that is not an object: the defaults, built the same way as any other policy
  const raw = input && typeof input === 'object' ? input : {}
  const r = raw.recovery && typeof raw.recovery === 'object' ? raw.recovery : {}
  const backoff = Array.isArray(r.backoffMinutes) ? r.backoffMinutes.filter((x) => Number.isFinite(x) && x >= 0.1 && x <= 24 * 60) : null
  const removed = raw.removed && typeof raw.removed === 'object' ? raw.removed : {}
  // the defaults, then the file's additions, less what the file removes
  const list = (k) => {
    const gone = new Set(strings(removed[k], []))
    return [...new Set([...d[k], ...strings(raw[k], [])])].filter((x) => !gone.has(x))
  }
  /** of what the file removes, the entries that really are built-in defaults */
  const taken = (k) => strings(removed[k], []).filter((x) => d[k].includes(x))
  return {
    version: 1,
    read: list('read'),
    write: list('write'),
    bash: list('bash'),
    /** what autopilot may spend before it stops sending and opening chats; null for no limit */
    budget: budgetOf(raw.budget),
    /** how long "away" runs by default, in minutes */
    minutes: num(raw.minutes, 240, 1, 24 * 60),
    repos: repoOverrides(raw.repos),
    /** the built-in defaults this file switches off: kept so a refusal can say so (removedDefault) */
    removed: { read: taken('read'), write: taken('write'), bash: taken('bash') },
    recovery: {
      stallMinutes: num(r.stallMinutes, d.recovery.stallMinutes, 2, 24 * 60),
      maxNudges: num(r.maxNudges, d.recovery.maxNudges, 0, 50),
      backoffMinutes: backoff?.length ? backoff : [...d.recovery.backoffMinutes],
      switchAccounts: typeof r.switchAccounts === 'boolean' ? r.switchAccounts : d.recovery.switchAccounts,
    },
  }
}

/** write a starting file once, so there is one to edit: empty additions and removals, the recovery settings */
export function ensurePolicyFile(file = policyFile()) {
  if (existsSync(file)) return
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const empty = { read: [], write: [], bash: [] }
    writeFileSync(file, `${JSON.stringify({ version: 1, ...empty, removed: empty, recovery: DEFAULT_POLICY.recovery }, null, 2)}\n`, { mode: 0o600 })
  } catch {}
}

// ------------------------------------------------------------------ paths ----
/** file names that hold secrets: never read or written without you */
const SECRET_NAMES = [
  /^\.env(\..*)?$/i,
  /^\.envrc$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc)$/i,
  /^id_[^.]*(\.pub)?$/i,
  /\.keychain(-db)?$/i,
  /^keychains$/i,
  /^\.ssh$/i,
  /^\.gnupg$/i,
  /^\.aws$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.docker$/i,
  /^\.kube$/i,
  /^credentials(\..*)?$/i,
  /^secrets?(\..*)?$/i,
  /^\.git-credentials$/i,
]
/** places an edit could change what runs or what is allowed: git internals, hooks, Claude's own settings */
const PROTECTED_WRITE = [/^\.git$/i, /^\.claude$/i, /^\.mcp\.json$/i, /^\.husky$/i, /^lefthook(-local)?\.ya?ml$/i, /^\.github$/i, /^\.vscode$/i]

const segments = (p) => String(p).split(/[\\/]+/).filter(Boolean)
const isSecret = (p) => segments(p).some((s) => SECRET_NAMES.some((re) => re.test(s)))

/** the real location of a path that may not exist yet: its nearest existing parent, resolved */
function realish(p) {
  let head = p
  const tail = []
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse())
    } catch {
      const up = dirname(head)
      if (up === head) return null
      tail.push(basename(head))
      head = up
    }
  }
}

const within = (root, p) => {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Is `p` inside `cwd`, as written and once symlinks are followed? `..` anywhere and `~` are
 * refused outright rather than reasoned about. Returns the reason it is not, or null.
 */
export function outsideCwd(p, cwd) {
  if (typeof p !== 'string' || !p.trim()) return 'no path given'
  if (p.includes('\0')) return 'path contains a NUL byte'
  if (!cwd || !isAbsolute(cwd)) return 'the chat has no folder'
  if (p.startsWith('~')) return 'path starts with ~'
  if (segments(p).includes('..')) return 'path contains ..'
  const abs = resolve(cwd, p)
  if (!within(resolve(cwd), abs)) return 'path is outside the chat folder'
  let root
  try {
    root = realpathSync(cwd)
  } catch {
    return 'the chat folder does not exist'
  }
  const real = realish(abs)
  if (!real || !within(root, real)) return 'path leads outside the chat folder (symlink)'
  return null
}

// ------------------------------------------------------------------- bash ----
/** anything that chains, redirects, substitutes, expands or escapes: refused, never parsed around */
const SHELL_META = /[;&|<>`$\\\n\r(){}!#*?[\]]/
/** words that never run while you are away, wherever they appear in a command */
const FORBIDDEN_WORDS = new Set([
  'sudo', 'su', 'doas', 'rm', 'rmdir', 'mv', 'dd', 'chmod', 'chown', 'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat',
  'telnet', 'ftp', 'vercel', 'netlify', 'fly', 'heroku', 'aws', 'gcloud', 'az', 'kubectl', 'docker', 'gh', 'push', 'commit',
  'reset', 'checkout', 'clean', 'rebase', 'merge', 'publish', 'deploy', 'release', 'restore', 'switch', 'stash', 'am',
  'apply', 'cherry-pick', 'revert', 'tag', 'fetch', 'pull', 'clone', 'remote', 'config', 'update-ref', 'filter-branch',
  'gc', 'prune', 'worktree', 'submodule', 'eval', 'exec', 'sh', 'bash', 'zsh', 'env', 'xargs', 'open', 'osascript',
  'unpublish', 'login', 'logout', 'adduser', 'token',
])

/** split a command into words, honouring plain quotes; null if it cannot be read plainly */
export function shellWords(cmd) {
  const words = []
  let cur = ''
  let quote = null
  let any = false
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      any = true
    } else if (ch === ' ' || ch === '\t') {
      if (any || cur) words.push(cur)
      cur = ''
      any = false
    } else cur += ch
  }
  if (quote) return null
  if (any || cur) words.push(cur)
  return words
}

/** flags a git subcommand may never have while away (they write files or run configured programs) */
const GIT_BAD_FLAGS = /^(--output(=|$)|-o$|--ext-diff$|--textconv$|--no-index$|--exec(=|$)|--upload-pack|--receive-pack)/
/** `git branch` only lists: these flags, and names only with --list */
const GIT_BRANCH_FLAGS = /^(-a|-r|-v|-vv|-l|--list|--all|--remotes|--verbose|--show-current|--no-color|--color(=\w+)?|--no-abbrev|--abbrev=\d+|--column(=\w+)?|--no-column|--sort=[\w:-]+|--format=.*|--contains=[\w./-]+|--no-contains=[\w./-]+|--merged=[\w./-]+|--no-merged=[\w./-]+|--points-at=[\w./-]+|--ignore-case|-i)$/

/**
 * `exec` is never run while away, with one narrow exception: `pnpm exec` of these checkers.
 * Their flags are held to the same rules as through npx (read-only: no --fix, --write, emit).
 */
const EXEC_TOOLS = { vitest: null, tsc: null, eslint: null, biome: 'check' }
/** is the `exec` at words[1] one of the allowed checkers? */
const execExempt = (words) =>
  words[0] === 'pnpm' && words[1] === 'exec' && Object.hasOwn(EXEC_TOOLS, words[2] ?? '') && (EXEC_TOOLS[words[2]] === null || words[3] === EXEC_TOOLS[words[2]])

/** a flag's name, without its dashes or =value */
const flagName = (w) => w.replace(/^-+/, '').split('=')[0]

/** the rules past the allowlisted prefix; returns the reason a command is refused, or null */
function bashRules(words, prefix) {
  const rest = words.slice(prefix.length)
  const [tool, sub] = prefix
  if (tool === 'pnpm' && sub === 'exec') {
    // pnpm exec <checker> ...: the checker's own rules, as through npx
    if (!execExempt(words)) return '"exec" is never run while away'
    return bashRules(['npx', ...words.slice(2)], ['npx', ...prefix.slice(2)])
  }
  if (tool === 'cargo') {
    if (!['test', 'check', 'clippy', 'build'].includes(sub)) return 'not an allowed command'
    // --config and -Z change how cargo runs (runners, rustc wrappers); --fix edits the source
    for (const w of rest) {
      if (w === '--') break
      if (/^(--config(=|$)|-Z|--fix$|--broken-code$|--allow-dirty$|--allow-staged$|-C$)/.test(w)) return `cargo ${sub} ${w} is not allowed`
    }
    return null
  }
  if (tool === 'make') {
    // only the named check targets, and a few flags that change nothing but speed and noise
    const args = words.slice(1)
    for (let i = 0; i < args.length; i++) {
      const w = args[i]
      if (['test', 'check', 'lint'].includes(w)) continue
      if (/^(-j\d*|--jobs=\d+|-k|--keep-going|-s|--silent)$/.test(w)) continue
      if (/^\d+$/.test(w) && args[i - 1] === '-j') continue
      return `make ${w} is not allowed (only test, check and lint)`
    }
    return null
  }
  if (tool === 'go') {
    if (!['test', 'vet', 'build'].includes(sub)) return 'not an allowed command'
    // -exec, -toolexec and -vettool run another program; the flags lists can name a linker
    for (const w of rest) {
      if (!w.startsWith('-')) continue
      if (['exec', 'toolexec', 'vettool', 'ldflags', 'gcflags', 'asmflags', 'gccgoflags'].includes(flagName(w))) return `go ${sub} ${w} is not allowed`
    }
    return null
  }
  if (tool === 'pytest' || ((tool === 'python' || tool === 'python3') && sub === '-m' && prefix[2] === 'pytest')) {
    for (const w of rest) {
      // -p loads plugins, -o overrides the config, -c picks a config file: short flags can be run together (-xp)
      if (/^-[A-Za-z]/.test(w) && /[pco]/.test(w.slice(1).split('=')[0])) return `pytest ${w} is not allowed`
      if (/^--(override-ini|basetemp|pdb|trace)(=|$)/.test(w)) return `pytest ${w} is not allowed`
    }
    return null
  }
  if (tool === 'swift') {
    if (!['test', 'build'].includes(sub)) return 'not an allowed command'
    // -X passes flags to the compiler and linker (plugins); the sandbox keeps package plugins in
    for (const w of rest) if (/^(-X|--disable-sandbox$|--toolset(=|$))/.test(w)) return `swift ${sub} ${w} is not allowed`
    return null
  }
  if (tool === 'git') {
    for (const w of rest) if (GIT_BAD_FLAGS.test(w)) return `git ${sub} with ${w} can write files or run programs`
    if (sub === 'branch') {
      const listing = rest.includes('--list') || rest.includes('-l')
      for (const w of rest) {
        if (w.startsWith('-')) {
          if (!GIT_BRANCH_FLAGS.test(w)) return `git branch ${w} is not a listing flag`
        } else if (!listing) return 'git branch with a name creates a branch'
      }
    }
    return null
  }
  if (tool === 'npm') {
    // npm reads config flags anywhere (--prefix, --userconfig): only arguments after -- are the script's
    const dd = rest.indexOf('--')
    const before = dd < 0 ? rest : rest.slice(0, dd)
    if (before.length) return 'npm options before -- are not allowed'
    return null
  }
  if (tool === 'npx') {
    if (sub === 'tsc') {
      for (const w of rest) if (/^(-b|--build|-w|--watch|--init|--outDir|--outFile|--declaration|--emitDeclarationOnly|-p|--project)$/.test(w.split('=')[0])) return `tsc ${w} is not allowed`
      if (/^--noEmit=/.test(rest.join(' '))) return 'tsc --noEmit must stay on'
      if (!words.includes('--noEmit')) return 'tsc must run with --noEmit'
    }
    if (sub === 'vitest') for (const w of rest) if (/^(--ui|--api|--open|-u|--update|--outputFile)/.test(w)) return `vitest ${w} is not allowed`
    if (sub === 'eslint') for (const w of rest) if (/^(--fix|--init$|-o$|--output-file)/.test(w)) return `eslint ${w} is not allowed`
    if (sub === 'biome') {
      if (!['check', 'lint', 'ci'].includes(words[2])) return 'biome may only check, lint or ci while away'
      for (const w of rest) if (/^(--write|--apply|--apply-unsafe|--fix|--unsafe)(=|$)/.test(w)) return `biome ${w} is not allowed`
    }
    return null
  }
  if (tool === 'node') {
    for (const w of rest) if (w.startsWith('-') && !/^--test(-[a-z-]+)?(=.*)?$/.test(w)) return `node ${w} is not allowed`
    return null
  }
  if (tool === 'pnpm') {
    // pnpm passes options after the script name to the script; before it they are pnpm's own (-C, --dir, -w)
    return null
  }
  return 'not an allowed command'
}

/** the allowlist entry a command starts with, or null */
const matchPrefix = (words, allow) => {
  for (const entry of allow) {
    const p = entry.split(/\s+/)
    if (p.length <= words.length && p.every((w, i) => words[i] === w)) return p
  }
  return null
}

/** a leading `cd <dir> && rest`: the folder as written (quoted or not) and the rest; null if absent */
const LEADING_CD = /^cd[ \t]+(?:"([^"]*)"|'([^']*)'|([^\s"'&;|<>]+))[ \t]*&&([\s\S]*)$/

/**
 * Chats often run `cd "<their folder>" && git status && git log -5`. That is allowed only when the
 * cd is the first thing, names an absolute folder inside the chat's own (after ~ when unquoted),
 * and every `&&` step after it would be allowed on its own, checked against that folder.
 */
function decideCdChain(cmd, cwd, policy) {
  const m = LEADING_CD.exec(cmd)
  if (!m) return 'cd must be followed by a folder and &&'
  const quoted = m[3] === undefined
  let dir = m[1] ?? m[2] ?? m[3]
  if (!dir || SHELL_META.test(dir) || /[\x00-\x1f\x7f]/.test(dir)) return 'cd names no plain folder'
  if (dir.startsWith('-')) return 'cd with a flag or - is not allowed'
  if (!quoted && (dir === '~' || dir.startsWith('~/'))) dir = join(homedir(), dir.slice(1))
  if (!isAbsolute(dir)) return 'cd must name the chat folder by its full path'
  const why = outsideCwd(dir, cwd)
  if (why) return `cd: ${why}`
  if (isSecret(dir)) return 'cd into a secret folder'
  const steps = m[4].split('&&').map((x) => x.trim())
  if (steps.join(' ').length > 400) return 'command is too long to check'
  for (const step of steps) {
    if (!step) return 'empty step after &&'
    if (/^cd(\s|$)/.test(step)) return 'only one cd, at the start, is allowed'
    const stepWhy = decideSimpleBash(step, dir, policy)
    if (stepWhy) return stepWhy
  }
  return null
}

export function decideBash(command, cwd, policy = DEFAULT_POLICY) {
  const cmd = String(command ?? '').trim()
  if (!cmd) return 'empty command'
  if (/^cd(\s|$)/.test(cmd)) {
    if (cmd.length > 1000) return 'command is too long to check'
    return decideCdChain(cmd, cwd, policy)
  }
  return decideSimpleBash(cmd, cwd, policy)
}

/** one command with no chaining at all */
function decideSimpleBash(cmd, cwd, policy) {
  if (!cmd) return 'empty command'
  if (cmd.length > 400) return 'command is too long to check'
  if (SHELL_META.test(cmd)) return 'command uses shell syntax (chaining, redirection, substitution or globbing)'
  const words = shellWords(cmd)
  if (!words?.length) return 'command could not be read'
  if (/=/.test(words[0])) return 'command sets environment variables'
  // the one exec allowed: `pnpm exec` of a read-only checker (EXEC_TOOLS)
  const execAt = execExempt(words) ? 1 : -1
  for (const [i, w] of words.entries()) {
    if (FORBIDDEN_WORDS.has(w.toLowerCase()) && i !== execAt) return `"${w}" is never run while away`
    if (/[\x00-\x1f\x7f]/.test(w)) return 'command contains control characters'
  }
  const prefix = matchPrefix(words, policy.bash ?? [])
  if (!prefix) return 'command is not on the away allowlist'
  // every word that names a path must stay in the folder and away from secrets
  for (const w of words.slice(prefix.length)) {
    const parts = [w, ...w.split(/[=:,]/).slice(1)]
    for (const part of parts) {
      if (!part) continue
      if (isSecret(part)) return `"${w}" touches a secret file`
      if (part.startsWith('/') || part.includes('..') || part.startsWith('~') || part.includes('/')) {
        const why = outsideCwd(part, cwd)
        if (why) return `"${w}": ${why}`
      }
    }
  }
  return bashRules(words, prefix)
}

// ------------------------------------------------------------------ decide ----
/** the paths a file tool's input names (Grep and Glob default to the folder itself) */
function pathsOf(tool, input) {
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return [input.file_path]
    case 'NotebookRead':
    case 'NotebookEdit':
      return [input.notebook_path]
    case 'LS':
      return [input.path]
    case 'Glob':
    case 'Grep':
      return [input.path ?? '.']
    default:
      return [undefined]
  }
}

/**
 * Should this tool call go ahead without you, while away?
 * `session` needs `cwd`. Pure apart from resolving symlinks on disk.
 * @returns {{ allow: boolean, reason: string }}
 */
export function decide(toolName, input, session, wanted = DEFAULT_POLICY) {
  const no = (reason) => ({ allow: false, reason })
  const tool = String(toolName ?? '')
  const args = input && typeof input === 'object' ? input : {}
  const cwd = session?.cwd
  // this chat's repo may allow a few more shell commands than the rest (policyFor)
  const policy = policyFor(wanted, session)
  if (tool === 'AskUserQuestion') return no('questions go to the conductor, not the away policy')
  if (tool.startsWith('mcp__')) return no('MCP tools always wait for you while away')
  if (tool === 'WebFetch' || tool === 'WebSearch') return no('the web always waits for you while away')
  if (!cwd) return no('the chat has no folder')

  const reads = policy.read ?? []
  const writes = policy.write ?? []
  if (reads.includes(tool) || writes.includes(tool)) {
    const writing = writes.includes(tool)
    for (const p of pathsOf(tool, args)) {
      const why = outsideCwd(p, cwd)
      if (why) return no(why)
      if (isSecret(p)) return no('it may hold secrets')
      if (writing) {
        const rel = relative(realpathSync(cwd), realish(resolve(cwd, p)) ?? '')
        if (segments(rel).some((s) => PROTECTED_WRITE.some((re) => re.test(s)))) return no('it is git or tool configuration')
      }
    }
    // a search pattern can name files too
    for (const k of ['pattern', 'glob']) {
      if (tool === 'Grep' && k === 'pattern') continue
      const g = args[k]
      if (typeof g !== 'string') continue
      if (g.startsWith('/') || g.startsWith('~') || segments(g).includes('..')) return no(`${k} reaches outside the chat folder`)
      if (isSecret(g.replace(/[*?[\]{}!]/g, ''))) return no(`${k} names secret files`)
    }
    return { allow: true, reason: writing ? 'edit inside the chat folder' : 'read inside the chat folder' }
  }
  if (tool === 'Bash') {
    if (args.run_in_background) return no('background commands wait for you')
    const why = decideBash(args.command, cwd, policy)
    return why ? no(why) : { allow: true, reason: 'local check command on the allowlist' }
  }
  return no(`${tool || 'this tool'} is not on the away allowlist`)
}

// ----------------------------------------------------------------- explain ----
const NOT_LISTED = 'command is not on the away allowlist'
/** a word a pattern may hold: no paths, quotes or anything the shell reads */
const PLAIN_WORD = /^[A-Za-z0-9][A-Za-z0-9:@._+-]*$/
/** runners whose next word is only a verb: the script or tool after it is what matters */
const RUNNER_VERBS = { pnpm: ['run', 'exec', 'dlx'], npm: ['run', 'run-script', 'exec'], yarn: ['run', 'exec', 'dlx'], bun: ['run', 'x'] }

/** the shortest sensible allowlist entry for one simple command's words, or null */
function patternFor(words) {
  const [prog, a, b] = words ?? []
  // a word with a file extension (script.mjs) names a file, not a subcommand
  const sub = (w) => !!w && PLAIN_WORD.test(w) && !/\.[A-Za-z]\w*$/.test(w)
  // programs with rules of their own whose pattern is not two plain words
  if (prog === 'pytest') return 'pytest'
  if ((prog === 'python' || prog === 'python3') && a === '-m' && b === 'pytest') return `${prog} -m pytest`
  if (!prog || !PLAIN_WORD.test(prog) || !sub(a)) return null
  // biome's verb matters: check is read-only, format is not
  if (prog === 'pnpm' && a === 'exec' && b === 'biome') return sub(words[3]) ? `pnpm exec biome ${words[3]}` : null
  if (prog === 'npx' && a === 'biome') return sub(b) ? `npx biome ${b}` : null
  if (RUNNER_VERBS[prog]?.includes(a)) return sub(b) ? `${prog} ${a} ${b}` : null
  return `${prog} ${a}`
}

/** the reason a hand-written pattern cannot go on the allowlist, or null */
function patternProblem(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) return 'the pattern is empty'
  if (SHELL_META.test(pattern) || /["'=\x00-\x1f\x7f]/.test(pattern)) return 'the pattern holds shell syntax'
  const words = pattern.trim().split(/\s+/)
  if (words.length < 2 && words[0] !== 'pytest') return 'a pattern must be more than a bare program name'
  const execAt = execExempt(words) ? 1 : -1
  if (words.some((w, i) => FORBIDDEN_WORDS.has(w.toLowerCase()) && i !== execAt)) return 'the pattern names a command that never runs while away'
  if (words.some((w) => w.includes('/') || w.startsWith('~'))) return 'a pattern cannot name a path'
  if (words[0].startsWith('-')) return 'a pattern must start with a program'
  return null
}

/** the one step that is refused only for its prefix: the command, or a step of a leading-cd chain */
function unlistedStep(command, policy) {
  const cmd = String(command ?? '').trim()
  let steps = [cmd]
  if (/^cd(\s|$)/.test(cmd)) {
    const m = LEADING_CD.exec(cmd)
    if (!m) return null
    steps = m[4].split('&&').map((x) => x.trim())
  }
  for (const step of steps) {
    if (SHELL_META.test(step)) return null
    const words = shellWords(step)
    if (words?.length && !matchPrefix(words, policy.bash ?? [])) return words
  }
  return null
}

const SYNTAX_PLAIN = [
  [/;/, 'It chains commands with ;, which away mode never runs without you.'],
  [/\|/, 'It pipes one command into another, which away mode never runs without you.'],
  [/[<>]/, 'It redirects input or output, which away mode never runs without you.'],
  [/[`$]/, 'It substitutes values into the command, which away mode never runs without you.'],
  [/&/, 'It chains or backgrounds commands with &, which away mode never runs without you.'],
  [/[*?[\]]/, 'It uses wildcards, which away mode never runs without you.'],
  [/[(){}]/, 'It groups commands with brackets, which away mode never runs without you.'],
  [/[\n\r]/, 'It runs more than one line, which away mode never does without you.'],
]

/** one plain sentence for a refusal reason */
function plainReason(tool, input, reason, pattern) {
  const r = String(reason ?? '')
  if (tool === 'Bash') {
    if (r === NOT_LISTED) return pattern ? `\`${pattern}\` isn't on the away allowlist yet.` : "This command isn't on the away allowlist."
    if (r.startsWith('command uses shell syntax')) {
      const cmd = String(input?.command ?? '').replace(/^cd[ \t][^&]*&&/, '').replaceAll('&&', ' ')
      return SYNTAX_PLAIN.find(([re]) => re.test(cmd))?.[1] ?? 'It uses shell syntax that away mode never runs without you.'
    }
    const word = /^"(.+)" is never run while away$/.exec(r)
    if (word) return `It uses "${word[1]}", which away mode never runs without you.`
    if (r === 'command sets environment variables') return 'It sets environment variables first, which away mode never does without you.'
    if (r.endsWith('touches a secret file') || r === 'cd into a secret folder') return 'It touches a file that may hold secrets.'
    if (r === 'only one cd, at the start, is allowed') return 'It changes folder more than once; away mode allows one cd, at the start.'
    if (r === 'cd must name the chat folder by its full path') return "It changes folder by a short path; away mode needs the chat folder's full path."
    if (r.startsWith('cd: ')) return "It changes into a folder outside this chat's own."
    if (r.startsWith('cd ') || r === 'empty step after &&') return "Its cd isn't the simple kind away mode allows."
    if (r === 'background commands wait for you') return 'It runs in the background, which always waits for you.'
    if (r === 'command is too long to check') return 'The command is too long to check safely.'
    if (r === 'not an allowed command') return 'Away mode has no safety rules for this program, so it always waits for you.'
  }
  if (/outside the chat folder|path contains \.\.|path starts with ~|reaches outside/.test(r)) return "It reaches outside this chat's folder."
  if (r === 'it may hold secrets' || r.endsWith('names secret files')) return 'The file may hold secrets.'
  if (r === 'it is git or tool configuration') return 'It changes git or tool configuration, which always waits for you.'
  const tl = / is not on the away allowlist$/.exec(r)
  if (tl) return `Away mode never uses ${tool || 'this tool'} without you.`
  return r ? `${r[0].toUpperCase()}${r.slice(1)}.` : 'Away mode left this for you.'
}

/**
 * Why away mode left this for you, in plain words, and the allowlist entry that would let it
 * through next time, offered only when the missing entry is the sole reason (checked by deciding
 * again with it added) and the entry is more than a bare program name.
 * @returns {{ allow: boolean, reason: string, plain: string | null, allowPattern: string | null }}
 */
export function explainRefusal(toolName, input, session, policy = DEFAULT_POLICY) {
  const d = decide(toolName, input, session, policy)
  if (d.allow) return { allow: true, reason: d.reason, plain: null, allowPattern: null }
  let allowPattern = null
  // the reason to put to you: past the allowlist, a command can still fail on its paths or flags
  let shown = d.reason
  if (toolName === 'Bash' && d.reason === NOT_LISTED) {
    const p = patternFor(unlistedStep(input?.command, policy))
    if (p && !patternProblem(p)) {
      const again = decide(toolName, input, session, { ...policy, bash: [...(policy.bash ?? []), p] })
      if (again.allow) allowPattern = p
      else shown = again.reason
    }
  }
  const tool = String(toolName ?? '')
  // a built-in default this file switched off: say so, rather than leaving the chat to report
  // that away mode "never" does this. Getting that wrong once cost four hours of stalled chats.
  const gone = removedDefault(tool, allowPattern, policy)
  const plain = gone ? `Your away policy file switches off the built-in \u201c${gone}\u201d, so this waits for you. Put it back in Policy.` : plainReason(tool, input, shown, allowPattern)
  return { allow: false, reason: d.reason, plain, allowPattern, removedDefault: gone }
}

/**
 * The built-in default behind a refusal, when the policy file is what took it away: the tool
 * itself, or the shell pattern that would have covered the command. Null when the refusal is the
 * policy working as designed.
 */
function removedDefault(tool, allowPattern, policy) {
  const rm = policy?.removed ?? {}
  if ((rm.read ?? []).includes(tool) || (rm.write ?? []).includes(tool)) return tool
  if (allowPattern && (rm.bash ?? []).includes(allowPattern)) return allowPattern
  return null
}

/**
 * Add a shell pattern to the policy file's `bash` list (and take it out of `removed.bash`),
 * keeping everything else in the file. Throws on a pattern that could never be safe.
 * @returns {{ pattern: string, added: boolean }}
 */
export function allowBashPattern(pattern, file = policyFile(), { repo = null } = {}) {
  const why = patternProblem(pattern)
  if (why) throw new Error(`Can't allow that pattern: ${why}`)
  const p = pattern.trim().split(/\s+/).join(' ')
  const raw = readPolicyFile(file)
  // one repo only: kept under repos.<name>, where it can never widen anything else
  if (repo) {
    const name = String(repo).trim()
    if (!name) throw new Error('Say which repo')
    const repos = raw.repos && typeof raw.repos === 'object' ? raw.repos : (raw.repos = {})
    const r = repos[name] && typeof repos[name] === 'object' ? repos[name] : (repos[name] = {})
    const bash = Array.isArray(r.bash) ? r.bash : []
    const added = !bash.includes(p)
    if (added) r.bash = [...bash, p]
    if (Array.isArray(r.removed?.bash)) r.removed.bash = r.removed.bash.filter((x) => x !== p)
    writePolicyFile(file, raw)
    return { pattern: p, added, repo: name }
  }
  const bash = Array.isArray(raw.bash) ? raw.bash : []
  // a built-in the file had taken out only needs putting back: listed as an addition, the panel could never take it away again
  const added = !bash.includes(p) && !DEFAULT_POLICY.bash.includes(p)
  if (added) raw.bash = [...bash, p]
  if (Array.isArray(raw.removed?.bash)) raw.removed.bash = raw.removed.bash.filter((x) => x !== p)
  writePolicyFile(file, raw)
  return { pattern: p, added }
}

/** the policy file as it is on disk, or a fresh one; throws only if it is there and is not an object */
function readPolicyFile(file) {
  if (!existsSync(file)) return { version: 1 }
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The away policy file is not a JSON object')
  return raw
}

/** write the policy file whole, through a temporary file so a crash cannot leave half of one */
function writePolicyFile(file, raw) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
  return raw
}

/**
 * Put a built-in default the file had switched off back: it comes out of `removed`, so it is
 * approved unattended again. This is the one the policy view puts at the top — a default quietly
 * removed once left four hours away with no approvals at all.
 * @returns {{ pattern: string, restored: boolean }}
 */
export function restoreDefault(pattern, file = policyFile()) {
  const p = String(pattern ?? '').trim().split(/\s+/).join(' ')
  if (!p || !existsSync(file)) return { pattern: p, restored: false }
  const raw = readPolicyFile(file)
  const gone = raw.removed && typeof raw.removed === 'object' ? raw.removed : null
  if (!gone) return { pattern: p, restored: false }
  let restored = false
  for (const k of ['read', 'write', 'bash']) {
    if (!Array.isArray(gone[k])) continue
    const kept = gone[k].filter((x) => String(x ?? '').trim().split(/\s+/).join(' ') !== p)
    if (kept.length !== gone[k].length) {
      gone[k] = kept
      restored = true
    }
  }
  if (restored) writePolicyFile(file, raw)
  return { pattern: p, restored }
}

/** the budget and the default away time, saved in the same file the allowlists live in */
export function saveBudget({ budget, minutes }, file = policyFile()) {
  const raw = readPolicyFile(file)
  if (budget !== undefined) {
    const b = budgetOf(budget && typeof budget === 'object' ? { dollars: budget.dollars == null ? undefined : Number(budget.dollars), spawns: budget.spawns == null ? undefined : Number(budget.spawns) } : null)
    if (b) raw.budget = b
    else delete raw.budget
  }
  if (minutes != null) {
    const m = Number(minutes)
    if (!Number.isFinite(m) || m < 1 || m > 24 * 60) throw new Error('Away time must be between 1 minute and 24 hours')
    raw.minutes = Math.round(m)
  }
  writePolicyFile(file, raw)
  return normalisePolicy(raw)
}

/** take a per-repo shell pattern back out; the repo entry goes when nothing is left in it */
export function removeRepoPattern(pattern, repo, file = policyFile()) {
  const p = String(pattern ?? '').trim().split(/\s+/).join(' ')
  const name = String(repo ?? '').trim()
  if (!p || !name || !existsSync(file)) return { pattern: p, removed: false }
  const raw = readPolicyFile(file)
  const r = raw.repos?.[name]
  if (!r || !Array.isArray(r.bash)) return { pattern: p, removed: false }
  const bash = r.bash.filter((x) => String(x ?? '').trim().split(/\s+/).join(' ') !== p)
  if (bash.length === r.bash.length) return { pattern: p, removed: false }
  r.bash = bash
  if (!r.bash.length && !r.removed?.bash?.length) delete raw.repos[name]
  writePolicyFile(file, raw)
  return { pattern: p, removed: true }
}

/**
 * What the policy file adds to the defaults, and what it takes out: only the file's own entries
 * (a default the file happens to repeat is not an addition). No file, or an unreadable one, adds nothing.
 * @returns {{ read: string[], write: string[], bash: string[], removed: { read: string[], write: string[], bash: string[] } }}
 */
export function listPolicyAdditions(file = policyFile()) {
  let raw = null
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {}
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const gone = r.removed && typeof r.removed === 'object' ? r.removed : {}
  const added = (k) => [...new Set(strings(r[k], []))].filter((x) => !DEFAULT_POLICY[k].includes(x))
  const taken = (k) => [...new Set(strings(gone[k], []))].filter((x) => DEFAULT_POLICY[k].includes(x))
  return {
    read: added('read'),
    write: added('write'),
    bash: added('bash'),
    removed: { read: taken('read'), write: taken('write'), bash: taken('bash') },
    repos: repoOverrides(r.repos),
    budget: budgetOf(r.budget),
    minutes: num(r.minutes, 240, 1, 24 * 60),
  }
}

/**
 * Take a shell pattern the file added back out, keeping everything else in the file. A default
 * cannot be removed this way (that is `removed.bash`, edited by hand).
 * @returns {{ pattern: string, removed: boolean }}
 */
export function removeBashPattern(pattern, file = policyFile()) {
  const p = String(pattern ?? '').trim().split(/\s+/).join(' ')
  if (!p || DEFAULT_POLICY.bash.includes(p) || !existsSync(file)) return { pattern: p, removed: false }
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The away policy file is not a JSON object')
  if (!Array.isArray(raw.bash)) return { pattern: p, removed: false }
  const bash = raw.bash.filter((x) => typeof x !== 'string' || x.trim().split(/\s+/).join(' ') !== p)
  if (bash.length === raw.bash.length) return { pattern: p, removed: false }
  raw.bash = bash
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
  return { pattern: p, removed: true }
}

// --------------------------------------------------------------------- log ----
const clip = (t, n) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** a short line for what a tool call does */
export function inputSummary(tool, input = {}) {
  if (tool === 'Bash') return clip(input.command, 160)
  const p = input.file_path ?? input.notebook_path ?? input.path
  if (p) return clip(`${p}${input.pattern ? ` ${input.pattern}` : ''}`, 160)
  if (input.pattern) return clip(input.pattern, 160)
  if (input.url) return clip(input.url, 160)
  return clip(JSON.stringify(input), 160)
}

/** append one line to the away log; never throws */
export function logAway(entry, file = logFile()) {
  const row = { at: new Date().toISOString(), ...entry }
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 })
  } catch {}
  return row
}

/** the log's recent lines, newest last; `since` is a ms timestamp */
export function readAwayLog({ since = 0, limit = 500 } = {}, file = logFile()) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (Date.parse(r.at) >= since) rows.push(r)
    } catch {}
  }
  return rows.slice(-limit)
}
