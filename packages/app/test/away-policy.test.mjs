import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { allowBashPattern, DEFAULT_POLICY, decide, ensurePolicyFile, explainRefusal, inputSummary, listPolicyAdditions, loadPolicy, logAway, normalisePolicy, readAwayLog, removeBashPattern, shellWords } from '../away-policy.mjs'

let cwd, outside, spaced, s
beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'away-policy-'))
  cwd = join(base, 'repo')
  outside = join(base, 'elsewhere')
  mkdirSync(join(cwd, 'src'), { recursive: true })
  mkdirSync(join(cwd, '.git'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  spaced = join(base, 'my repo')
  mkdirSync(join(spaced, 'src'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'a.ts'), 'x')
  writeFileSync(join(outside, 'secret.txt'), 'x')
  symlinkSync(outside, join(cwd, 'escape'))
  symlinkSync(join(outside, 'secret.txt'), join(cwd, 'src', 'innocent.ts'))
  s = { cwd }
})

const bash = (command) => decide('Bash', { command }, s)

describe('away policy: reads', () => {
  it.each([
    ['Read', { file_path: 'src/a.ts' }],
    ['Read', { file_path: '__CWD__/src/a.ts' }],
    ['Read', { file_path: '__CWD__/src/not-yet.ts' }],
    ['Glob', { pattern: '**/*.ts' }],
    ['Glob', { pattern: '*.ts', path: '__CWD__/src' }],
    ['Grep', { pattern: 'foo.*bar' }],
    ['Grep', { pattern: 'x', path: 'src', glob: '*.ts' }],
    ['LS', { path: '__CWD__' }],
    ['NotebookRead', { notebook_path: 'nb.ipynb' }],
  ])('allows %s %j', (tool, input) => {
    const fixed = JSON.parse(JSON.stringify(input).replaceAll('__CWD__', cwd))
    expect(decide(tool, fixed, s)).toMatchObject({ allow: true })
  })

  it.each([
    ['absolute outside', 'Read', { file_path: '/etc/passwd' }],
    ['parent dir', 'Read', { file_path: '../elsewhere/secret.txt' }],
    ['dot-dot inside path', 'Read', { file_path: 'src/../../elsewhere/secret.txt' }],
    ['tilde', 'Read', { file_path: '~/.ssh/id_rsa' }],
    ['symlinked dir escape', 'Read', { file_path: 'escape/secret.txt' }],
    ['symlinked file escape', 'Read', { file_path: 'src/innocent.ts' }],
    ['.env', 'Read', { file_path: '.env' }],
    ['.env.local', 'Read', { file_path: 'config/.env.local' }],
    ['pem', 'Read', { file_path: 'certs/server.pem' }],
    ['ssh key', 'Read', { file_path: 'keys/id_ed25519' }],
    ['ssh dir', 'Read', { file_path: '.ssh/config' }],
    ['keychain', 'Read', { file_path: 'login.keychain-db' }],
    ['npmrc', 'Read', { file_path: '.npmrc' }],
    ['no path', 'Read', {}],
    ['LS outside', 'LS', { path: '/Users' }],
    ['Glob path outside', 'Glob', { pattern: '*', path: '/' }],
    ['Glob pattern outside', 'Glob', { pattern: '../**/*' }],
    ['Glob pattern absolute', 'Glob', { pattern: '/etc/*' }],
    ['Grep glob for secrets', 'Grep', { pattern: 'KEY', glob: '.env*' }],
    ['Grep path secret', 'Grep', { pattern: 'KEY', path: '.env' }],
    ['Grep outside', 'Grep', { pattern: 'x', path: '/etc' }],
  ])('refuses %s', (_why, tool, input) => {
    expect(decide(tool, input, s).allow).toBe(false)
  })
})

describe('away policy: edits', () => {
  it.each([
    ['Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }],
    ['Write', { file_path: 'src/new/file.ts', content: '' }],
    ['MultiEdit', { file_path: 'src/a.ts', edits: [] }],
    ['NotebookEdit', { notebook_path: 'nb.ipynb', new_source: '' }],
  ])('allows %s inside the folder', (tool, input) => {
    expect(decide(tool, input, s)).toMatchObject({ allow: true })
  })

  it.each([
    ['.git', 'Write', { file_path: '.git/hooks/pre-commit' }],
    ['.git config', 'Edit', { file_path: '.git/config' }],
    ['.claude settings', 'Write', { file_path: '.claude/settings.local.json' }],
    ['.mcp.json', 'Write', { file_path: '.mcp.json' }],
    ['husky hook', 'Write', { file_path: '.husky/pre-push' }],
    ['workflow', 'Write', { file_path: '.github/workflows/deploy.yml' }],
    ['outside', 'Write', { file_path: '/tmp/x' }],
    ['symlink escape', 'Write', { file_path: 'escape/new.txt' }],
    ['parent', 'Edit', { file_path: '../elsewhere/secret.txt' }],
    ['.env', 'Write', { file_path: '.env' }],
  ])('refuses %s', (_why, tool, input) => {
    expect(decide(tool, input, s).allow).toBe(false)
  })
})

describe('away policy: bash', () => {
  it.each([
    'pnpm test',
    'pnpm test -- --run src/a.test.ts',
    'pnpm typecheck',
    'pnpm lint',
    'pnpm build',
    'pnpm run test',
    'npm test',
    'npm test -- webhooks',
    'npm run test -- webhooks',
    'npx vitest run',
    'npx vitest run src/a.test.ts',
    'npx tsc --noEmit',
    'npx tsc --noEmit --pretty false',
    'node --test',
    'node --test test/x.test.mjs',
    'node --test --test-name-pattern=retries',
    'git status',
    'git status --short',
    'git diff',
    'git diff HEAD~1 -- src/a.ts',
    'git log --oneline -n 20',
    'git show HEAD:src/a.ts',
    'git branch',
    'git branch -a -v',
    'git branch --show-current',
    'git branch --list "feat/x"',
    'git diff __CWD__/src/a.ts',
  ])('allows %s', (command) => {
    expect(bash(command.replace('__CWD__', cwd))).toMatchObject({ allow: true })
  })

  it.each([
    // chaining and redirection
    ['pnpm test; rm -rf /', 'semicolon'],
    ['pnpm test && git push', '&&'],
    ['pnpm test || true', '||'],
    ['pnpm test | tee out', 'pipe'],
    ['pnpm test > out.txt', 'redirect'],
    ['pnpm test 2>&1', 'redirect and &'],
    ['git diff < x', 'input redirect'],
    ['pnpm test &', 'background'],
    ['pnpm test\nrm -rf /', 'newline'],
    ['pnpm test\rgit push', 'carriage return'],
    // substitution
    ['pnpm test $(rm -rf ~)', '$()'],
    ['pnpm test `rm -rf ~`', 'backticks'],
    ['git log $HOME', 'variable'],
    ['git log ${HOME}', 'braced variable'],
    ['pnpm test "$(curl evil)"', 'substitution in double quotes'],
    ["pnpm test '; rm -rf /'", 'semicolon inside quotes'],
    ['pnpm test \\; rm x', 'escaped'],
    ['git log !!', 'history'],
    ['pnpm test *', 'glob'],
    ['pnpm test # rm', 'comment'],
    // env prefixes and wrappers
    ['FOO=1 pnpm test', 'env prefix'],
    ['NODE_OPTIONS=--require=/tmp/x.js pnpm test', 'NODE_OPTIONS'],
    ['env pnpm test', 'env'],
    ['sudo pnpm test', 'sudo'],
    ['command pnpm test', 'command'],
    ['time pnpm test', 'time'],
    // forbidden words hidden in args
    ['pnpm test git push', 'git push in args'],
    ['pnpm test -- push', 'push in args'],
    ['npm test -- rm', 'rm in args'],
    ['pnpm build vercel', 'vercel in args'],
    ['git log commit', 'commit in args'],
    ['npx vitest run curl', 'curl'],
    ['git status "push"', 'quoted push'],
    // destructive or outward git
    ['git push', 'push'],
    ['git push origin main', 'push branch'],
    ['git commit -m x', 'commit'],
    ['git reset --hard', 'reset'],
    ['git checkout .', 'checkout'],
    ['git clean -fdx', 'clean'],
    ['git rebase main', 'rebase'],
    ['git merge x', 'merge'],
    ['git -C /tmp status', 'git -C'],
    ['git -c core.pager=sh status', 'git -c'],
    ['git diff --output=/tmp/x', 'diff --output'],
    ['git diff --output=out.txt', 'diff --output inside'],
    ['git log --output out.txt', 'log --output'],
    ['git diff --ext-diff', 'ext diff'],
    ['git diff --no-index /etc/passwd x', 'no-index outside'],
    ['git branch new-branch', 'creates a branch'],
    ['git branch -D main', 'deletes a branch'],
    ['git branch -m a b', 'renames a branch'],
    ['git branch --set-upstream-to=origin/x', 'upstream'],
    ['git stash', 'stash'],
    ['git show HEAD:.env', 'secret via show'],
    // other package managers and flags
    ['npm publish', 'publish'],
    ['npm test --prefix=/tmp', 'npm prefix'],
    ['npm test --userconfig x', 'npm userconfig'],
    ['npm install', 'install'],
    ['npm run build', 'npm build is not on the list'],
    ['pnpm install', 'pnpm install'],
    ['pnpm -C /tmp test', 'pnpm -C'],
    ['pnpm --dir .. test', 'pnpm --dir'],
    ['pnpm dlx evil', 'dlx'],
    ['pnpm exec rm x', 'exec'],
    ['npx -y evil', 'npx -y'],
    ['npx evil-package', 'npx other'],
    ['npx tsc', 'tsc without noEmit'],
    ['npx tsc --noEmit --build', 'tsc build'],
    ['npx vitest --ui', 'vitest ui'],
    ['node --test --require /tmp/x.js', 'node require outside'],
    ['node --test --import=./evil.mjs', 'node import'],
    ['node -e "process.exit()"', 'node -e'],
    ['node script.js', 'node script'],
    // paths
    ['pnpm test ../elsewhere/x.test.ts', 'parent path'],
    ['pnpm test /etc/passwd', 'absolute outside'],
    ['pnpm test ~/x', 'tilde'],
    ['node --test escape/secret.txt', 'symlink escape'],
    ['pnpm test --config=../x.ts', 'flag value parent'],
    ['pnpm test --config=/tmp/x.ts', 'flag value absolute'],
    ['npx vitest run .env', 'secret file'],
    // misc
    ['rm -rf node_modules', 'rm'],
    ['curl https://x', 'curl'],
    ['wget x', 'wget'],
    ['ssh host', 'ssh'],
    ['vercel deploy --prod', 'vercel'],
    ['ls', 'not listed'],
    ['cat .env', 'cat'],
    ['', 'empty'],
    ['pnpm "test', 'unclosed quote'],
    [`pnpm test ${'x'.repeat(500)}`, 'too long'],
  ])('refuses %j (%s)', (command) => {
    expect(bash(command).allow).toBe(false)
  })

  it('refuses background commands', () => {
    expect(decide('Bash', { command: 'pnpm test', run_in_background: true }, s).allow).toBe(false)
  })
})

describe('away policy: other languages’ checks', () => {
  it.each([
    'cargo test',
    'cargo test --workspace -- --nocapture',
    'cargo test -p core',
    'cargo check --all-targets',
    'cargo clippy -- -D warnings',
    'cargo build --release',
    'cargo test --manifest-path crates/a/Cargo.toml',
    'make test',
    'make check',
    'make lint',
    'make test -j8',
    'make check -j 4',
    'make test lint',
    'make test -k -s',
    'go test ./...',
    'go test -run TestX -v ./pkg/...',
    'go vet ./...',
    'go build ./...',
    'go build -o bin/app ./cmd/app',
    'pytest',
    'pytest -x -q tests/test_a.py',
    'pytest -k retries --maxfail=1',
    'pytest --rootdir=src',
    'python -m pytest',
    'python3 -m pytest -v tests',
    'swift test',
    'swift test --filter MyTests',
    'swift build -c debug',
  ])('allows %s', (command) => {
    expect(bash(command)).toMatchObject({ allow: true })
  })

  it.each([
    // cargo
    ['cargo run', 'cargo run'],
    ['cargo install ripgrep', 'install'],
    ['cargo publish', 'publish'],
    ['cargo test --config target.x.runner="sh"', 'config runner'],
    ['cargo test --config=build.rustc-wrapper=evil', 'config ='],
    ['cargo test -Zunstable-options', '-Z'],
    ['cargo clippy --fix', 'clippy --fix'],
    ['cargo clippy --fix --allow-dirty', 'allow dirty'],
    ['cargo test --manifest-path ../x/Cargo.toml', 'manifest outside'],
    ['cargo build --target-dir /tmp/t', 'target dir outside'],
    ['cargo +nightly test', 'toolchain first'],
    ['RUSTC_WRAPPER=evil cargo build', 'env'],
    // make
    ['make', 'bare make'],
    ['make install', 'other target'],
    ['make test deploy', 'extra target'],
    ['make -f other.mk test', '-f'],
    ['make -C /tmp test', '-C'],
    ['make -C sub test', '-C inside'],
    ['make -e test', '-e'],
    ['make test CC=evil', 'VAR='],
    ['make test SHELL=/bin/sh', 'SHELL='],
    ['make --file=x test', '--file'],
    ['make test -j release', 'release target'],
    ['make test -j8 install', 'install after flags'],
    ['make -j8 test', 'flags before the target'],
    // go
    ['go run .', 'go run'],
    ['go generate ./...', 'go generate'],
    ['go install ./...', 'go install'],
    ['go get x', 'go get'],
    ['go test -exec evil ./...', '-exec'],
    ['go test -exec=evil ./...', '-exec='],
    ['go test --exec evil', '--exec'],
    ['go build -toolexec evil ./...', '-toolexec'],
    ['go vet -vettool=evil ./...', '-vettool'],
    ['go build -ldflags=-extld=evil', '-ldflags'],
    ['go build -o /tmp/app', '-o outside'],
    ['go build -o ../app', '-o parent'],
    ['go build -o=~/bin/app', '-o tilde'],
    ['go test -modfile=/tmp/go.mod', 'modfile outside'],
    // pytest
    ['pytest -p evil', '-p'],
    ['pytest -pevil', '-p joined'],
    ['pytest -xp evil', '-p clustered'],
    ['pytest -p no:cacheprovider', '-p no:'],
    ['pytest -c /tmp/pytest.ini', '-c outside'],
    ['pytest -c pytest.ini', '-c'],
    ['pytest --rootdir=/tmp', 'rootdir outside'],
    ['pytest --rootdir ../x', 'rootdir parent'],
    ['pytest --config-file=/tmp/x.ini', 'config file outside'],
    ['pytest -o addopts=-pevil', '-o'],
    ['pytest --override-ini=addopts=x', 'override-ini'],
    ['pytest --basetemp=build', 'basetemp (deleted)'],
    ['pytest --pdb', 'pdb'],
    ['python -m http.server', 'python other module'],
    ['python -c "import os"', 'python -c'],
    ['python script.py', 'python script'],
    ['python -m pytest -p evil', 'python -m pytest -p'],
    ['PYTEST_ADDOPTS=-pevil pytest', 'env'],
    // swift
    ['swift run', 'swift run'],
    ['swift package update', 'swift package'],
    ['swift build -Xswiftc -load-plugin-library', '-Xswiftc'],
    ['swift build --disable-sandbox', 'sandbox'],
    ['swift build -c release', 'release is a forbidden word'],
    ['swift build --package-path /tmp/p', 'package path outside'],
    ['swift test --scratch-path ../b', 'scratch path parent'],
  ])('refuses %j (%s)', (command) => {
    expect(bash(command).allow).toBe(false)
  })

  it('a narrowed policy refuses them, and a widened one still keeps their rules', () => {
    const p = normalisePolicy({ removed: { bash: ['cargo test', 'make test'] }, bash: ['make install', 'go run', 'cargo run'] })
    expect(decide('Bash', { command: 'cargo test' }, s, p).allow).toBe(false)
    expect(decide('Bash', { command: 'make test' }, s, p).allow).toBe(false)
    expect(decide('Bash', { command: 'make check' }, s, p).allow).toBe(true)
    expect(decide('Bash', { command: 'make install' }, s, p).allow).toBe(false)
    expect(decide('Bash', { command: 'go run .' }, s, p).allow).toBe(false)
    expect(decide('Bash', { command: 'cargo run' }, s, p).allow).toBe(false)
  })
})

describe('away policy: pnpm exec of a checker, and only that', () => {
  it.each([
    'pnpm exec vitest',
    'pnpm exec vitest run',
    'pnpm exec vitest run test/a.test.ts',
    'pnpm exec tsc --noEmit',
    'pnpm exec tsc --noEmit --pretty false',
    'pnpm exec biome check',
    'pnpm exec biome check src',
    'pnpm exec eslint src',
    'pnpm exec eslint --max-warnings 0 .',
    'npx biome check',
    'npx biome check src --diagnostic-level=error',
    'cd "__CWD__" && pnpm exec vitest run && pnpm exec tsc --noEmit',
  ])('allows %s', (command) => {
    expect(bash(command.replace('__CWD__', cwd))).toMatchObject({ allow: true })
  })

  it.each([
    ['pnpm exec rm -rf x', 'exec rm'],
    ['pnpm exec node x.mjs', 'exec node'],
    ['pnpm exec sh -c x', 'exec sh'],
    ['pnpm exec prettier --write .', 'exec other tool'],
    ['pnpm exec', 'bare exec'],
    ['pnpm exec vitest exec', 'second exec'],
    ['pnpm exec vitest --ui', 'vitest ui'],
    ['pnpm exec vitest -u', 'vitest update snapshots'],
    ['pnpm exec vitest run ../x.test.ts', 'vitest path outside'],
    ['pnpm exec tsc', 'tsc emits'],
    ['pnpm exec tsc --build', 'tsc build'],
    ['pnpm exec tsc --noEmit --outDir /tmp', 'tsc outDir'],
    ['pnpm exec tsc --noEmit -p tsconfig.json', 'tsc project, as through npx'],
    ['pnpm exec tsc --noEmit=false', 'tsc noEmit false'],
    ['pnpm exec biome format --write .', 'biome format write'],
    ['pnpm exec biome format .', 'biome format'],
    ['pnpm exec biome check --write', 'biome check write'],
    ['pnpm exec biome check --apply', 'biome apply'],
    ['pnpm exec biome check --apply-unsafe', 'biome apply unsafe'],
    ['pnpm exec biome check --fix', 'biome fix'],
    ['pnpm exec biome', 'bare biome'],
    ['pnpm exec eslint --fix src', 'eslint fix'],
    ['pnpm exec eslint --fix-dry-run src', 'eslint fix dry run'],
    ['pnpm exec eslint -o report.txt', 'eslint output'],
    ['pnpm --filter x exec vitest', 'pnpm flags before exec'],
    ['pnpm -C /tmp exec vitest', 'pnpm -C'],
    ['npx biome check --write', 'npx biome write'],
    ['npx biome format --write .', 'npx biome format'],
    ['npx exec vitest', 'npx exec'],
    ['npm exec vitest', 'npm exec'],
    ['git exec', 'git exec'],
    ['find . -exec rm x', 'find -exec'],
    ['exec pnpm test', 'bare exec'],
    ['pnpm test exec', 'exec in args'],
  ])('refuses %j (%s)', (command) => {
    expect(bash(command).allow).toBe(false)
  })

  it('a policy file cannot widen exec to another program', () => {
    const p = normalisePolicy({ bash: ['pnpm exec node', 'pnpm exec prettier', 'git exec'] })
    expect(decide('Bash', { command: 'pnpm exec node x' }, s, p).allow).toBe(false)
    expect(decide('Bash', { command: 'pnpm exec prettier --check .' }, s, p).allow).toBe(false)
    expect(() => allowBashPattern('pnpm exec node', join(mkdtempSync(join(tmpdir(), 'away-exec-')), 'p.json'))).toThrow()
  })
})

describe('away policy: cd into the chat folder, then read-only steps', () => {
  const fill = (command) => command.replaceAll('__CWD__', cwd).replaceAll('__OUT__', outside)

  it.each([
    'cd "__CWD__" && git rev-parse HEAD',
    'cd __CWD__ && git rev-parse HEAD',
    "cd '__CWD__' && git branch --show-current",
    'cd __CWD__ && git branch --show-current',
    'cd __CWD__/ && git status',
    'cd "__CWD__" && git status && git log --oneline -5',
    'cd "__CWD__" && git status --short && git diff && git branch -a -v',
    'cd __CWD__&&git status',
    'cd "__CWD__/src" && git log --oneline -n 3',
    'cd "__CWD__" && git diff __CWD__/src/a.ts',
    'cd "__CWD__" && pnpm test',
  ])('allows %s', (command) => {
    expect(bash(fill(command))).toMatchObject({ allow: true })
  })

  it('allows a quoted folder with spaces', () => {
    const s2 = { cwd: spaced }
    expect(decide('Bash', { command: `cd "${spaced}" && git rev-parse HEAD` }, s2)).toMatchObject({ allow: true })
    expect(decide('Bash', { command: `cd '${spaced}/src' && git status && git log --oneline -5` }, s2)).toMatchObject({ allow: true })
    // unquoted, the space splits the folder name
    expect(decide('Bash', { command: `cd ${spaced} && git status` }, s2).allow).toBe(false)
  })

  it.each([
    // somewhere else
    ['cd __OUT__ && git status', 'other absolute folder'],
    ['cd "/tmp" && git log', 'tmp'],
    ['cd / && git status', 'root'],
    ['cd .. && git status', 'relative parent'],
    ['cd __CWD__/.. && git status', 'dot-dot escape'],
    ['cd "__CWD__/../elsewhere" && git status', 'dot-dot into sibling'],
    ['cd __CWD__/escape && git status', 'symlink escape'],
    ['cd src && git status', 'relative folder'],
    ['cd . && git status', 'dot'],
    ['cd - && git status', 'cd -'],
    ['cd && git status', 'no folder'],
    ['cd ~ && git status', 'home'],
    ['cd "~/x" && git status', 'quoted tilde'],
    ['cd -P __CWD__ && git status', 'cd flag'],
    ['cd $HOME && git status', 'variable'],
    ['cd "$PWD" && git status', 'quoted variable'],
    ['cd $(pwd) && git status', 'substitution'],
    ['cd "`pwd`" && git status', 'backticks'],
    ['cd __CWD__', 'cd alone'],
    ['cd __CWD__ ; git status', 'semicolon instead of &&'],
    ['cd __CWD__ || git status', '||'],
    ['cd "__CWD__"x && git status', 'junk after quote'],
    // writes and anything not allowed on its own
    ['cd "__CWD__" && git push', 'push'],
    ['cd "__CWD__" && git status && git push origin main', 'push later'],
    ['cd __CWD__ && git commit -m x', 'commit'],
    ['cd __CWD__ && git checkout main', 'checkout'],
    ['cd __CWD__ && rm -rf src', 'rm'],
    ['cd __CWD__ && git log > out.txt', 'redirect'],
    ['cd __CWD__ && git status && git log >> out.txt', 'append redirect later'],
    ['cd __CWD__ && git log | tee out', 'pipe'],
    ['cd __CWD__ && git status &&& rm x', 'triple &'],
    ['cd __CWD__ && git status &', 'background'],
    ['cd __CWD__ && git status && ', 'trailing &&'],
    ['cd __CWD__ && git status; rm -rf /', 'semicolon later'],
    ['cd __CWD__ && git log $(rm x)', 'substitution later'],
    ['cd __CWD__ && git status\nrm x', 'newline later'],
    ['cd __CWD__ && ls', 'not on the list'],
    ['cd __CWD__ && git diff /etc/passwd', 'path outside in a step'],
    ['cd __CWD__/src && git show HEAD:.env', 'secret in a step'],
    ['cd __CWD__ && FOO=1 git status', 'env prefix in a step'],
    // a second cd
    ['cd __CWD__ && cd __CWD__/src && git status', 'second cd inside'],
    ['cd __CWD__ && git status && cd __OUT__ && git status', 'second cd elsewhere'],
    ['cd __CWD__ && git status && cd .. && git status', 'second cd up'],
  ])('refuses %j (%s)', (command) => {
    expect(bash(fill(command)).allow).toBe(false)
  })
})

describe('away policy: never', () => {
  it.each([
    ['WebFetch', { url: 'https://example.com' }],
    ['WebSearch', { query: 'x' }],
    ['mcp__slack__send_message', { text: 'hi' }],
    ['mcp__fleet__fleet_send', { chat: 'x', text: 'y' }],
    ['AskUserQuestion', { questions: [] }],
    ['Task', { prompt: 'x' }],
    ['ExitPlanMode', {}],
    ['KillShell', {}],
    ['SomethingNew', { file_path: 'src/a.ts' }],
  ])('passes %s to you', (tool, input) => {
    expect(decide(tool, input, s).allow).toBe(false)
  })

  it('refuses everything without a folder', () => {
    expect(decide('Read', { file_path: '/x' }, {}).allow).toBe(false)
    expect(decide('Read', { file_path: 'x' }, { cwd: 'relative' }).allow).toBe(false)
  })

  it('always gives a reason', () => {
    expect(decide('Bash', { command: 'git push' }, s).reason).toMatch(/push/)
    expect(decide('Read', { file_path: 'src/a.ts' }, s).reason).toBeTruthy()
  })
})

describe('away policy as data', () => {
  it('reads the file, falls back to defaults, and removed narrows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'away-policy-file-'))
    const file = join(dir, 'away-policy.json')
    expect(loadPolicy(file)).toEqual(normalisePolicy(DEFAULT_POLICY))
    ensurePolicyFile(file)
    // a fresh file holds only additions and removals: the defaults come from the code
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ bash: [], removed: { read: [], write: [], bash: [] } })
    expect(loadPolicy(file)).toEqual(normalisePolicy(DEFAULT_POLICY))
    writeFileSync(file, JSON.stringify({ removed: { write: DEFAULT_POLICY.write, bash: ['pnpm test'] }, recovery: { stallMinutes: 5 } }))
    const p = loadPolicy(file)
    expect(p.recovery.stallMinutes).toBe(5)
    expect(p.recovery.maxNudges).toBe(DEFAULT_POLICY.recovery.maxNudges)
    expect(decide('Edit', { file_path: 'src/a.ts' }, s, p).allow).toBe(false)
    expect(decide('Bash', { command: 'pnpm test' }, s, p).allow).toBe(false)
    expect(decide('Bash', { command: 'git status' }, s, p).allow).toBe(true)
    writeFileSync(file, '{ not json')
    expect(loadPolicy(file).bash).toEqual(DEFAULT_POLICY.bash)
  })

  it('a file holding a full copy of older defaults still gets the new ones, plus its own additions', () => {
    const old = DEFAULT_POLICY.bash.filter((x) => x !== 'git rev-parse')
    const p = normalisePolicy({ read: [...DEFAULT_POLICY.read], write: [...DEFAULT_POLICY.write], bash: [...old, 'pnpm run e2e', ' git status '] })
    expect(p.bash).toContain('git rev-parse')
    expect(p.bash).toContain('pnpm run e2e')
    // no duplicates from the overlap
    expect(p.bash.filter((x) => x === 'git status')).toHaveLength(1)
    expect(decide('Bash', { command: 'git rev-parse HEAD' }, s, p).allow).toBe(true)
  })

  it('a widened file still cannot allow the hard limits', () => {
    const p = normalisePolicy({ read: ['WebFetch', 'mcp__x__y'], bash: ['rm', 'git push', 'curl'] })
    expect(decide('WebFetch', { url: 'x' }, s, p).allow).toBe(false)
    expect(decide('mcp__x__y', {}, s, p).allow).toBe(false)
    expect(decide('Bash', { command: 'rm -rf x' }, s, p).allow).toBe(false)
    expect(decide('Bash', { command: 'git push' }, s, p).allow).toBe(false)
  })

  it('splits shell words with quotes', () => {
    expect(shellWords(`git log --format="%h %s" 'a b'`)).toEqual(['git', 'log', '--format=%h %s', 'a b'])
    expect(shellWords('pnpm "test')).toBeNull()
  })
})

describe('away log', () => {
  it('appends lines and reads them back since a time', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'away-log-')), 'away-log.jsonl')
    const t0 = Date.now()
    logAway({ kind: 'approved', chat: 'abc', tool: 'Read', input: inputSummary('Read', { file_path: 'x' }), reason: 'r' }, file)
    logAway({ kind: 'asked', chat: 'abc', tool: 'Bash', input: inputSummary('Bash', { command: 'git push' }), reason: 'no' }, file)
    const rows = readAwayLog({ since: t0 - 1000 }, file)
    expect(rows.map((r) => r.kind)).toEqual(['approved', 'asked'])
    expect(rows[1].input).toBe('git push')
    expect(readAwayLog({ since: Date.now() + 60_000 }, file)).toEqual([])
  })
})

describe('away refusals, explained', () => {
  const without = (...drop) => ({ ...normalisePolicy(null), bash: normalisePolicy(null).bash.filter((b) => !drop.includes(b)) })
  const explain = (command, policy = normalisePolicy(null)) => explainRefusal('Bash', { command }, s, policy)

  it('says nothing when the policy allows it', () => {
    expect(explain('git status')).toEqual({ allow: true, reason: expect.any(String), plain: null, allowPattern: null })
  })

  it.each([
    ['a missing git subcommand', 'git rev-parse --show-toplevel', without('git rev-parse'), 'git rev-parse'],
    ['a pnpm script', 'pnpm run e2e --reporter dot', undefined, 'pnpm run e2e'],
    ['an npm script', 'npm run check', undefined, 'npm run check'],
    ['an npx tool', 'npx eslint src', undefined, 'npx eslint'],
    ['a bare pnpm command', 'pnpm vitest run', undefined, 'pnpm vitest'],
    ['one step of a cd chain', '__CD__ && git status && git rev-parse HEAD', without('git rev-parse'), 'git rev-parse'],
    ['pnpm exec vitest', 'pnpm exec vitest run', without('pnpm exec vitest'), 'pnpm exec vitest'],
    ['pnpm exec tsc', 'pnpm exec tsc --noEmit', without('pnpm exec tsc --noEmit'), 'pnpm exec tsc'],
    ['pnpm exec biome check', 'pnpm exec biome check src', without('pnpm exec biome check'), 'pnpm exec biome check'],
    ['npx biome check', 'npx biome check .', without('npx biome check'), 'npx biome check'],
    ['cargo test', 'cargo test --workspace', without('cargo test'), 'cargo test'],
    ['cargo clippy', 'cargo clippy -- -D warnings', without('cargo clippy'), 'cargo clippy'],
    ['make check', 'make check', without('make check'), 'make check'],
    ['go vet', 'go vet ./...', without('go vet'), 'go vet'],
    ['pytest', 'pytest -x tests', without('pytest'), 'pytest'],
    ['python -m pytest', 'python -m pytest -q', without('python -m pytest'), 'python -m pytest'],
    ['swift build', 'swift build', without('swift build'), 'swift build'],
  ])('offers a pattern for %s', (_why, command, policy, pattern) => {
    const x = explain(command.replace('__CD__', `cd "${cwd}"`), policy)
    expect(x).toMatchObject({ allow: false, allowPattern: pattern })
    expect(x.plain).toContain(pattern)
    // and the pattern really is the whole difference
    const p = policy ?? normalisePolicy(null)
    expect(decide('Bash', { command: command.replace('__CD__', `cd "${cwd}"`) }, s, { ...p, bash: [...p.bash, pattern] }).allow).toBe(true)
  })

  it.each([
    ['chaining', 'git status; git log', /chains commands with ;/],
    ['a pipe', 'git log | head', /pipes/],
    ['a redirect', 'git diff > out.txt', /redirects/],
    ['a forbidden word', 'git push origin main', /"push"/],
    ['pnpm exec of anything but a checker', 'pnpm exec node x', /"exec"/],
    ['pnpm exec of a forbidden program', 'pnpm exec rm x', /"exec"/],
    ['a path outside', 'npx eslint /etc/hosts', /outside/],
    ['a secret', 'npx eslint .env', /secrets/],
    ['an env prefix', 'CI=1 pnpm run e2e', /environment variables/],
    ['a bare program', 'make', /allowlist/],
    ['a program with only a flag', 'git --version', /allowlist/],
    ['a program with a file', 'node scripts/check.mjs', /allowlist/],
    ['a script file name', 'node check.mjs', /allowlist/],
    ['a program with no safety rules', 'deno test', /no safety rules/],
    ['a cargo subcommand with no rules', 'cargo run', /no safety rules/],
    ['a make target other than the checks', 'make deploy-all', /allowlist|not allowed/],
    ['a second cd', '__CD__ && cd src && git status', /more than once/],
    ['a cd by short path', 'cd src && git status', /full path/],
    ['two different unlisted steps', '__CD__ && npx eslint && npx prettier', /allowlist/],
  ])('offers no pattern for %s', (_why, command, plain) => {
    const x = explain(command.replace('__CD__', `cd "${cwd}"`))
    expect(x.allow).toBe(false)
    expect(x.allowPattern).toBeNull()
    expect(x.plain).toMatch(plain)
  })

  it('offers no pattern for other tools, and still explains them', () => {
    expect(explainRefusal('WebFetch', { url: 'https://x' }, s)).toMatchObject({ allowPattern: null, plain: expect.stringMatching(/web/) })
    expect(explainRefusal('Read', { file_path: '/etc/passwd' }, s)).toMatchObject({ allowPattern: null, plain: "It reaches outside this chat's folder." })
    expect(explainRefusal('Task', {}, s)).toMatchObject({ allowPattern: null, plain: 'Away mode never uses Task without you.' })
  })
})

describe('allowBashPattern', () => {
  const fresh = () => join(mkdtempSync(join(tmpdir(), 'away-allow-')), 'nested', 'away-policy.json')

  it('creates the file with just the addition, private', () => {
    const file = fresh()
    expect(allowBashPattern('pnpm run e2e', file)).toEqual({ pattern: 'pnpm run e2e', added: true })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, bash: ['pnpm run e2e'] })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('keeps the rest of the file, does not duplicate, and takes the pattern out of removed', () => {
    const file = fresh()
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, read: ['Read'], bash: ['npx eslint'], removed: { bash: ['pnpm run e2e', 'pnpm build'] }, recovery: { maxNudges: 1 } }))
    allowBashPattern('  pnpm   run e2e ', file)
    expect(allowBashPattern('pnpm run e2e', file).added).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      read: ['Read'],
      bash: ['npx eslint', 'pnpm run e2e'],
      removed: { bash: ['pnpm build'] },
      recovery: { maxNudges: 1 },
    })
  })

  it('works through LAIKA_AWAY_POLICY by default', () => {
    const file = fresh()
    const was = process.env.LAIKA_AWAY_POLICY
    process.env.LAIKA_AWAY_POLICY = file
    try {
      allowBashPattern('npx eslint')
      expect(loadPolicy().bash).toContain('npx eslint')
    } finally {
      if (was === undefined) delete process.env.LAIKA_AWAY_POLICY
      else process.env.LAIKA_AWAY_POLICY = was
    }
  })

  it.each([
    ['empty', '  '],
    ['a single word', 'git'],
    ['shell syntax', 'git status; rm x'],
    ['a pipe', 'git log | sh'],
    ['a quote', `git log '--x'`],
    ['a forbidden first word', 'rm -rf'],
    ['a forbidden word later', 'git push'],
    ['an env prefix', 'CI=1 pnpm'],
    ['a path', 'node ./x.mjs'],
    ['not a string', null],
  ])('refuses %s', (_why, pattern) => {
    const file = fresh()
    expect(() => allowBashPattern(pattern, file)).toThrow()
  })

  it('accepts the pnpm exec checkers and pytest', () => {
    const file = fresh()
    // built in already: accepted, nothing to add
    for (const p of ['pnpm exec vitest', 'pytest', 'python -m pytest']) expect(allowBashPattern(p, file)).toEqual({ pattern: p, added: !DEFAULT_POLICY.bash.includes(p) })
    expect(DEFAULT_POLICY.bash).toContain('pnpm exec vitest')
  })

  it('will not overwrite a policy file it cannot read', () => {
    const file = fresh()
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '{ not json')
    expect(() => allowBashPattern('git rev-parse', file)).toThrow()
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
  })
})

describe('listPolicyAdditions and removeBashPattern', () => {
  const fresh = (content) => {
    const file = join(mkdtempSync(join(tmpdir(), 'away-list-')), 'away-policy.json')
    if (content !== undefined) writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
    return file
  }
  // repos, budget and minutes come back too: a file with none of them says so plainly
  const none = { read: [], write: [], bash: [], removed: { read: [], write: [], bash: [] }, repos: {}, budget: null, minutes: 240 }

  it('lists only what the file adds and removes, never the defaults', () => {
    const file = fresh({
      version: 1,
      read: ['Read', 'NotebookRead'],
      bash: [...DEFAULT_POLICY.bash, 'npx eslint', ' pnpm run e2e ', 'npx eslint', 42],
      removed: { bash: ['pnpm build', 'not-a-default thing'], write: ['Write'] },
      recovery: { maxNudges: 1 },
    })
    expect(listPolicyAdditions(file)).toEqual({
      ...none,
      bash: ['npx eslint', 'pnpm run e2e'],
      removed: { read: [], write: ['Write'], bash: ['pnpm build'] },
    })
  })

  it('a missing, unreadable or odd file adds nothing', () => {
    expect(listPolicyAdditions(join(tmpdir(), 'away-no-such-dir', 'x.json'))).toEqual(none)
    expect(listPolicyAdditions(fresh('{ not json'))).toEqual(none)
    expect(listPolicyAdditions(fresh('[]'))).toEqual(none)
    expect(listPolicyAdditions(fresh({ bash: 'npx eslint', removed: 'x' }))).toEqual(none)
  })

  it('removes a file-added pattern and keeps the rest of the file', () => {
    const file = fresh({ version: 1, read: ['Read'], bash: ['npx eslint', 'pnpm   run e2e'], removed: { bash: ['pnpm build'] }, recovery: { maxNudges: 1 } })
    expect(removeBashPattern(' pnpm run  e2e ', file)).toEqual({ pattern: 'pnpm run e2e', removed: true })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, read: ['Read'], bash: ['npx eslint'], removed: { bash: ['pnpm build'] }, recovery: { maxNudges: 1 } })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(listPolicyAdditions(file).bash).toEqual(['npx eslint'])
    // and it is gone from the policy in force
    expect(loadPolicy(file).bash).not.toContain('pnpm run e2e')
    // a second time there is nothing to remove
    expect(removeBashPattern('pnpm run e2e', file).removed).toBe(false)
  })

  it('an always-allowed pattern round-trips', () => {
    const file = fresh()
    allowBashPattern('npx eslint', file)
    expect(listPolicyAdditions(file).bash).toEqual(['npx eslint'])
    expect(removeBashPattern('npx eslint', file).removed).toBe(true)
    expect(listPolicyAdditions(file).bash).toEqual([])
  })

  it('never removes a default, even one the file repeats', () => {
    const file = fresh({ bash: ['git status', 'npx eslint'] })
    const before = readFileSync(file, 'utf8')
    expect(removeBashPattern('git status', file)).toEqual({ pattern: 'git status', removed: false })
    expect(removeBashPattern('pnpm exec vitest', file).removed).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(loadPolicy(file).bash).toContain('git status')
  })

  it('does nothing for an unknown pattern, no file, or a file it cannot read', () => {
    const file = fresh({ bash: ['npx eslint'] })
    expect(removeBashPattern('npx prettier', file).removed).toBe(false)
    expect(removeBashPattern('', file).removed).toBe(false)
    expect(removeBashPattern(null, file).removed).toBe(false)
    const missing = join(mkdtempSync(join(tmpdir(), 'away-list-')), 'none.json')
    expect(removeBashPattern('npx eslint', missing).removed).toBe(false)
    const bad = fresh('{ not json')
    expect(() => removeBashPattern('npx eslint', bad)).toThrow()
    expect(readFileSync(bad, 'utf8')).toBe('{ not json')
  })
})

describe('always-allow on a built-in the file removed', () => {
  it('puts the built-in back instead of listing it as an addition the panel cannot remove', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'away-allow-default-')), 'away-policy.json')
    writeFileSync(file, JSON.stringify({ version: 1, bash: [], removed: { bash: ['make test', 'git rev-parse'] } }))
    expect(loadPolicy(file).bash).not.toContain('make test')
    expect(allowBashPattern('make test', file)).toEqual({ pattern: 'make test', added: false })
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    expect(raw).toMatchObject({ bash: [], removed: { bash: ['git rev-parse'] } })
    expect(loadPolicy(file).bash).toContain('make test')
    expect(listPolicyAdditions(file)).toMatchObject({ bash: [], removed: { bash: ['git rev-parse'] } })
  })
})
