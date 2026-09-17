#!/usr/bin/env node
/**
 * Builds a fictional workspace for filming the showcase: a brain, a home folder with Claude
 * Code sessions and memory, git repos with loose ends, and project documents. Nothing in it
 * comes from a real machine, so recordings can be shared.
 *
 *   node showcase/demo/make-world.mjs            → /tmp/orbit-studio (wiped and rebuilt)
 *   node showcase/demo/run.mjs                   → serves it on :5290
 *
 * Session timestamps are relative to now, so rebuild right before recording.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// a neutral path: it shows on screen inside file paths and Claude's project folder names
export const WORLD = process.env.DEMO_WORLD ?? '/tmp/orbit-studio'
const W = WORLD
const HOME = join(W, 'Users', 'demo')
const NOW = Date.now()
const min = (m) => new Date(NOW - m * 60_000)

rmSync(W, { recursive: true, force: true })

function put(rel, text, ageMin) {
  const p = join(W, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
  if (ageMin !== undefined) utimesSync(p, min(ageMin), min(ageMin))
  return p
}
const md = (title, ...paras) => `# ${title}\n\n${paras.join('\n\n')}\n`

// --------------------------------------------------------------------- brain ----
put('CLAUDE.md', md('Orbit Studio — workspace', 'Read `brain/CLAUDE.md` first. Routers are the index.'))
put(
  'brain/CLAUDE.md',
  md(
    'Orbit Studio brain — operating manual',
    'This knowledge base is read by agents. Routing beats hierarchy.',
    '- `routers/` typed pointer playbooks, one per department\n- `wiki/` index, log, processed\n- `rules/` hard constraints',
  ),
)
put(
  'brain/routers/ENGINEERING.md',
  `## 1 — platform

- Thinking: brain/wiki/index.md — what lives where in this workspace
- Rules: brain/rules/review-before-merge.md — every agent change gets a second agent review
- Reference: brain/wiki/log.md — decisions, newest first

## 2 — services

- Skills: code-review — review a branch before merge
- Skills: release-notes — draft notes from merged PRs
- Rules: brain/rules/no-secrets-in-repos.md — credentials live in the keychain, never in git
`,
)
put(
  'brain/routers/PRODUCT.md',
  `## 1 — roadmap

- Thinking: brain/wiki/index.md — product areas and owners
- Skills: research-brief — turn a question into a sourced brief
- Rules: brain/rules/ship-small.md — one reviewable change per session
`,
)
put(
  'brain/routers/CLIENTS.md',
  `## 1 — engagements

- Reference: brain/wiki/processed.md — client material already filed
- Rules: brain/rules/client-data-local.md — client data never leaves this machine
`,
)
for (const [f, t] of [
  ['review-before-merge', 'Every change an agent makes is reviewed by a second agent in fresh context before merge.'],
  ['no-secrets-in-repos', 'Credentials live in the keychain or .env.local. Never commit them.'],
  ['ship-small', 'One reviewable change per session. Big work is a sequence of small merges.'],
  ['client-data-local', 'Client material is indexed locally and never sent to a hosted service.'],
]) {
  put(`brain/rules/${f}.md`, md(f.replace(/-/g, ' '), t))
}
put('brain/wiki/index.md', md('Index', 'Platform: atlas-api, harbor-web. Mobile: pocket-app. Data: tide-pipelines.'))
put('brain/wiki/log.md', md('Log', '- Moved auth to passkeys\n- Split the ingest worker from the API\n- Adopted agent review before merge'))
put('brain/wiki/processed.md', md('Processed', 'Client notes filed this month.'))

const real = JSON.parse(execFileSync('cat', [resolve(HERE, '../../brain/index.config.json')], { encoding: 'utf8' }))
put(
  'brain/index.config.json',
  JSON.stringify(
    {
      ...real,
      exclude: [],
      topics: {},
      sources: [
        { id: 'workspace', label: 'This workspace', path: '.', enabled: true, include: [], exclude: ['Users/', 'remotes/'], content: true, maxDepth: 0 },
        { id: 'claude', label: 'Claude memory & plans', path: '~/.claude', enabled: true, include: ['projects/*/memory/*.md', 'plans/*.md', 'skills/**/*.md'], exclude: [], content: true, maxDepth: 0 },
        { id: 'dev', label: 'Project docs (~/dev)', path: '~/dev', enabled: true, include: ['*.md', '*.mdx'], exclude: [], content: true, maxDepth: 0 },
        { id: 'documents', label: 'Documents · Projects', path: '~/Documents/Projects', enabled: true, include: ['*.md', '*.txt', '*.html', '*.csv'], exclude: [], content: true, maxDepth: 0 },
      ],
    },
    null,
    2,
  ),
)

// ------------------------------------------------------------------- widgets ----
const iso = (m = 0) => min(m).toISOString()
const widget = (o) => put(`brain/widgets/${o.id}.json`, JSON.stringify({ refreshedAt: iso(2), ...o }, null, 2))
widget({
  id: 'apps',
  kind: 'applist',
  title: 'Micro Apps',
  source: 'local',
  rail: 'left',
  order: 1,
  config: { staleAfterMins: 100000 },
  items: [
    { title: 'Second Brain', meta: 'Your whole workspace as a living map', href: '#', icon: 'brain' },
    { title: 'Release Radar', meta: 'What shipped, what is queued', href: '#', icon: 'deploy' },
    { title: 'Docs', meta: '412 indexed files on this Mac', href: '#', icon: 'doc' },
  ],
})
const day = new Date(NOW)
const at = (dOff, h, m) => {
  const d = new Date(day)
  d.setDate(d.getDate() + dOff)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}
widget({
  id: 'calendar',
  kind: 'calendar',
  title: 'Calendar',
  source: 'calendar · ics',
  rail: 'left',
  order: 2,
  config: {
    staleAfterMins: 100000,
    home: 'Pacific/Auckland',
    homeLabel: 'NZST · AUCKLAND',
    zones: [
      { label: 'USA PT', tz: 'America/Los_Angeles' },
      { label: 'LONDON', tz: 'Europe/London' },
    ],
  },
  items: [
    { title: 'Standup', at: at(0, 9, 30), end: at(0, 9, 45) },
    { title: 'Design review · pocket-app', at: at(0, 13, 0), end: at(0, 14, 0) },
    { title: 'Focus block', at: at(0, 15, 0), end: at(0, 17, 0) },
    { title: 'Standup', at: at(1, 9, 30), end: at(1, 9, 45) },
    { title: 'Release planning', at: at(1, 11, 0), end: at(1, 12, 0) },
    { title: 'Standup', at: at(2, 9, 30), end: at(2, 9, 45) },
  ],
})
widget({
  id: 'skills',
  kind: 'deck',
  title: 'Skills Deck',
  source: '.claude/skills',
  rail: 'right',
  order: 3,
  config: { meta: 'tap ▸ to run', staleAfterMins: 100000 },
  items: [
    { title: '/code-review', meta: 'OPUS · HIGH', tag: 'repo' },
    { title: '/release-notes', meta: 'SONNET · MEDIUM', tag: 'repo' },
    { title: '/research-brief', meta: 'OPUS · HIGH', tag: 'brain' },
    { title: '/simplify', meta: 'SONNET · MEDIUM', tag: 'repo' },
  ],
})
widget({
  id: 'routines',
  kind: 'table',
  title: 'Routines',
  source: 'cron + agents',
  rail: 'right',
  order: 4,
  config: { meta: '2/4 fired today', columns: ['TIME', 'ROUTINE', 'STATUS'], staleAfterMins: 100000 },
  items: [
    { title: 'index rebuild', meta: '07:00', tag: 'FIRED', badge: 'local' },
    { title: 'dependency audit', meta: '10:00', tag: 'FIRED', badge: 'claude' },
    { title: 'release notes draft', meta: '16:00', tag: 'NEXT', badge: 'claude', accent: '#ff7a45' },
    { title: 'nightly review sweep', meta: '22:00', tag: 'QUEUED', badge: 'claude' },
  ],
})
widget({
  id: 'brainstat',
  kind: 'metric',
  title: 'Brain',
  source: '@laika/core',
  rail: 'left',
  order: 3,
  config: { value: '0', valueLabel: 'FILES\\nINDEXED', flaggedLabel: 'RETRIEVAL', segments: [], footer: '0 MODEL TOKENS PER QUERY' },
  items: [{ title: 'p50 recall latency', meta: '~1ms' }],
})
put(
  'brain/widgets/_settings.json',
  JSON.stringify({ apps: { order: 10, rail: 'left' }, calendar: { order: 20, rail: 'left' }, brainstat: { order: 30, rail: 'left' }, agents: { order: 10, rail: 'right' }, skills: { order: 20, rail: 'right' }, routines: { order: 30, rail: 'right' } }, null, 2),
)

// --------------------------------------------------------------------- repos ----
const REPOS = {
  'atlas-api': ['auth', 'billing', 'webhooks', 'rate-limits', 'search', 'audit-log', 'migrations', 'observability'],
  'harbor-web': ['onboarding', 'dashboard', 'settings', 'design-tokens', 'accessibility', 'checkout', 'i18n'],
  'pocket-app': ['offline-sync', 'push', 'deep-links', 'widgets', 'release-train', 'crash-triage'],
  'tide-pipelines': ['ingest', 'dedupe', 'backfill', 'schemas', 'costs'],
  'lumen-docs': ['getting-started', 'api-reference', 'guides', 'changelog', 'style'],
  'infra-terraform': ['networking', 'secrets', 'dns', 'runners'],
}
const DOC_KINDS = ['overview', 'decisions', 'runbook', 'todo', 'notes', 'spec', 'testing', 'metrics', 'open-questions', 'history']
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'Orbit Dev', GIT_AUTHOR_EMAIL: 'dev@orbit.example', GIT_COMMITTER_NAME: 'Orbit Dev', GIT_COMMITTER_EMAIL: 'dev@orbit.example' } })
const commit = (cwd, msg, hoursAgo) => {
  const d = min(hoursAgo * 60).toISOString()
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', msg], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'Orbit Dev', GIT_AUTHOR_EMAIL: 'dev@orbit.example', GIT_COMMITTER_NAME: 'Orbit Dev', GIT_COMMITTER_EMAIL: 'dev@orbit.example', GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d } })
}
// loose ends per repo: [commits made locally and not pushed, files left uncommitted]
const LOOSE = { 'atlas-api': [7, 3], 'harbor-web': [0, 12], 'pocket-app': [22, 0], 'tide-pipelines': [0, 0], 'lumen-docs': [2, 5], 'infra-terraform': [0, 2] }

for (const [repo, areas] of Object.entries(REPOS)) {
  const dir = join(HOME, 'dev', repo)
  put(`Users/demo/dev/${repo}/README.md`, md(repo, `Orbit Studio · ${repo}. See docs/ for area notes.`))
  put(`Users/demo/dev/${repo}/CLAUDE.md`, md(`${repo} — agent notes`, 'Run tests before claiming done. Keep changes small.'))
  for (const a of areas) {
    for (const k of DOC_KINDS.slice(0, 5 + (a.length % 6))) {
      put(`Users/demo/dev/${repo}/docs/${a}/${k}.md`, md(`${repo} · ${a} · ${k}`, `Notes on ${a} for ${repo}: ${k}.`, `- owner: platform\n- status: active`))
    }
  }
  const remote = join(W, 'remotes', `${repo}.git`)
  mkdirSync(remote, { recursive: true })
  sh(remote, 'init', '-q', '--bare', '-b', 'main')
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'add', '-A')
  commit(dir, 'initial import', 24 * 9)
  sh(dir, 'remote', 'add', 'origin', remote)
  sh(dir, 'push', '-q', '-u', 'origin', 'main')
  const [ahead, dirty] = LOOSE[repo]
  for (let i = 0; i < ahead; i++) commit(dir, `wip ${i + 1}`, ahead > 10 ? 50 - i : 6 - i * 0.5)
  // edits to tracked files, so each counts as its own uncommitted change
  const tracked = areas.flatMap((a) => DOC_KINDS.slice(0, 3).map((k) => `Users/demo/dev/${repo}/docs/${a}/${k}.md`))
  for (let i = 0; i < dirty; i++) put(tracked[i % tracked.length], md('work in progress', `edit ${i + 1}, not committed yet`))
}

// ----------------------------------------------------------- claude sessions ----
const slug = (p) => p.replace(/[/ .]/g, '-')
let uid = 0
const uuid = () => {
  uid++
  const h = (n) => ((uid * 2654435761 + n * 40503) >>> 0).toString(16).padStart(8, '0')
  return `${h(1)}-${h(2).slice(0, 4)}-4${h(3).slice(0, 3)}-a${h(4).slice(0, 3)}-${h(5)}${h(6).slice(0, 4)}`
}

/**
 * One transcript. `end` decides the state the control view derives:
 *   'reply'  model finished its turn → needs you
 *   'tool'   tool call still unanswered → blocked (older than 3m) or working (fresh)
 *   'user'   a prompt just went in → working
 */
function session({ repo, title, ask, reply, tool, end, ageMin, branch = 'main' }) {
  const cwd = join(HOME, 'dev', repo)
  const id = uuid()
  const t = (m) => min(m).toISOString()
  const base = { cwd, gitBranch: branch, isSidechain: false, sessionId: id }
  const recs = [
    { type: 'user', ...base, timestamp: t(ageMin + 40), message: { role: 'user', content: ask } },
    { type: 'assistant', ...base, timestamp: t(ageMin + 38), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Read', id: 't1', input: {} }] } },
    { type: 'user', ...base, timestamp: t(ageMin + 37), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'ai-title', aiTitle: title, sessionId: id },
  ]
  if (end === 'reply') {
    recs.push({ type: 'assistant', ...base, timestamp: t(ageMin), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] } })
  } else if (end === 'tool') {
    recs.push({ type: 'assistant', ...base, timestamp: t(ageMin + 1), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] } })
    recs.push({ type: 'assistant', ...base, timestamp: t(ageMin), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: tool, id: 't2', input: {} }] } })
  } else {
    recs.push({ type: 'assistant', ...base, timestamp: t(ageMin + 2), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] } })
    recs.push({ type: 'user', ...base, timestamp: t(ageMin), message: { role: 'user', content: ask } })
  }
  put(`Users/demo/.claude/projects/${slug(cwd)}/${id}.jsonl`, `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`, ageMin)
}

const SESSIONS = [
  { repo: 'atlas-api', title: 'Passkey sign-in for the admin console', ask: 'Add passkey sign-in to the admin console behind a flag.', reply: 'Passkey sign-in works behind the admin_passkeys flag. Registration, login and fallback to email links are covered by 14 new tests, all passing. One decision for you: should existing sessions be signed out when a passkey is first registered?', end: 'reply', ageMin: 2, branch: 'feat/passkeys' },
  { repo: 'pocket-app', title: 'Offline sync conflict resolution', ask: 'Fix the offline sync conflicts on reconnect.', reply: 'Found it: two devices editing the same list both win because the merge compares local clocks. I switched it to server-assigned versions and added a conflict banner. Ready for you to try on a device before I open the PR.', end: 'reply', ageMin: 9, branch: 'fix/sync-conflicts' },
  { repo: 'harbor-web', title: 'Checkout accessibility audit', ask: 'Audit checkout for accessibility issues and fix what you can.', reply: 'Fixed 11 of 13 issues: focus order, labels on the card fields, and contrast on the error text. The last two need a design call — the step indicator has no text equivalent. Want me to propose copy?', end: 'reply', ageMin: 26 },
  { repo: 'infra-terraform', title: 'Rotate the staging database credentials', ask: 'Rotate the staging database credentials.', reply: 'The new secret is in the vault. Next I need to apply the plan to staging.', tool: 'Bash', end: 'tool', ageMin: 7 },
  { repo: 'tide-pipelines', title: 'Backfill March events into the warehouse', ask: 'Backfill March events into the warehouse.', reply: 'Chunked the backfill by day to stay under the cost cap.', tool: 'Bash', end: 'tool', ageMin: 0.5 },
  { repo: 'lumen-docs', title: 'Rewrite the webhooks guide', ask: 'Rewrite the webhooks guide around the new retry policy.', reply: 'Drafted the outline.', end: 'user', ageMin: 0.3 },
  { repo: 'atlas-api', title: 'Rate limit headers on public endpoints', ask: 'Return rate limit headers on public endpoints.', reply: 'Done and merged.', end: 'reply', ageMin: 60 * 20 },
  { repo: 'harbor-web', title: 'Design tokens for dark mode', ask: 'Move the dashboard to design tokens.', reply: 'Tokens are in and the dashboard uses them.', end: 'reply', ageMin: 60 * 15 },
  { repo: 'pocket-app', title: 'Crash on deep link without a session', ask: 'Fix the crash on cold-start deep links.', reply: 'Fixed and released in 4.2.1.', end: 'reply', ageMin: 60 * 30 },
]
for (const s of SESSIONS) session(s)

// memory notes and plans agents wrote
const RICH_MEM = {
  'staging-credentials-rotate-monthly': `# Staging credentials rotate monthly

The staging database password rotates on the **first Monday** of each month.

## How

1. Generate the new secret in the vault: \`vault kv put staging/db password=…\`
2. Apply the plan: \`terraform apply -target=module.staging_db\`
3. Restart the API pods so they pick up the new secret
4. Confirm the health check is green, then revoke the old secret

## Gotchas

- The ingest worker caches its connection for 10 minutes — restart it too
- Never paste the secret into a ticket or a chat
`,
}
const MEM = {
  'atlas-api': ['passkey rollout plan', 'billing retries are idempotent', 'webhook signing secret rotation', 'audit log retention'],
  'pocket-app': ['sync uses server versions', 'release train every second tuesday', 'push token refresh'],
  'harbor-web': ['checkout step indicator copy', 'dark mode tokens', 'onboarding drop-off'],
  'tide-pipelines': ['backfill cost cap', 'dedupe keys'],
  'infra-terraform': ['staging credentials rotate monthly'],
}
for (const [repo, notes] of Object.entries(MEM)) {
  const d = `Users/demo/.claude/projects/${slug(join(HOME, 'dev', repo))}/memory`
  notes.forEach((n, i) => {
    const f = n.replace(/ /g, '-')
    put(`${d}/${f}.md`, RICH_MEM[f] ?? md(n, `Learned while working on ${repo}.`), 60 * (i * 5 + 1))
  })
  put(`${d}/MEMORY.md`, notes.map((n) => `- [${n}](${n.replace(/ /g, '-')}.md)`).join('\n'))
}
put(
  'Users/demo/.claude/plans/passkeys-rollout.md',
  `# Passkeys rollout

Replace passwords in the admin console with passkeys, without locking anyone out.

## Phases

1. **Behind a flag** — \`admin_passkeys\` on for the platform team only
2. **Opt-in** — a banner offers registration after the next sign-in
3. **Default** — new admins register a passkey at invite time
4. **Passwords off** — email links remain as the recovery path

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Library | WebAuthn server in atlas-api | no new vendor |
| Recovery | email magic link | already audited |
| Existing sessions | keep until expiry | avoids a forced sign-out wave |

## Checks before each phase

- [x] registration and login covered by tests
- [x] audit log records every credential change
- [ ] support runbook updated
- [ ] staging soak for 7 days

\`\`\`ts
await passkeys.verify({ challenge, credential, userId })
\`\`\`
`,
)
for (const p of ['sync-rewrite', 'q4-platform-plan', 'docs-restructure']) {
  put(`Users/demo/.claude/plans/${p}.md`, md(p.replace(/-/g, ' '), '1. Scope\n2. Build\n3. Review\n4. Ship'))
}
for (const [s, d] of [
  ['code-review', 'Review a branch for bugs before merge.'],
  ['release-notes', 'Draft release notes from merged pull requests.'],
  ['research-brief', 'Turn a question into a sourced brief.'],
  ['simplify', 'Reduce a change to its simplest correct form.'],
  ['incident-review', 'Write a blameless incident review from logs.'],
  ['migration-plan', 'Plan a zero-downtime schema migration.'],
  ['test-gaps', 'Find untested paths in a change.'],
  ['onboard-repo', 'Explain a repo to a new contributor.'],
]) {
  put(`Users/demo/.claude/skills/${s}/SKILL.md`, `---\nname: ${s}\ndescription: ${d}\n---\n\n# ${s}\n\n${d}\n`, s.length * 900)
}

// ---------------------------------------------------------------- documents ----
const DOCS = {
  'Q4 Planning': ['goals.md', 'headcount.md', 'risks.md', 'okrs.csv'],
  'Customer Research': ['interview-01.md', 'interview-02.md', 'interview-03.md', 'synthesis.md', 'survey-results.csv'],
  'Brand Refresh': ['brief.md', 'moodboard.html', 'naming-shortlist.txt'],
  'Hiring': ['platform-engineer.md', 'interview-loop.md', 'scorecard.md'],
}
for (const [folder, files] of Object.entries(DOCS)) {
  for (const f of files) {
    const body = f.endsWith('.csv')
      ? 'metric,target,actual\nactivation,40%,37%\nretention,85%,88%\nnps,45,51\n'
      : f.endsWith('.html')
        ? `<!doctype html><title>${folder}</title><h1>${folder}</h1><p>Warm neutrals, one accent, generous space.</p>`
        : md(`${folder} · ${f.replace(/\.\w+$/, '')}`, `Working notes for ${folder}.`)
    put(`Users/demo/Documents/Projects/${folder}/${f}`, body)
  }
}

console.log(`demo world → ${W}`)
