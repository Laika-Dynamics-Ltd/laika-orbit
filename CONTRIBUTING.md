# Contributing

Issues and pull requests are welcome. Laika Orbit is a preview, so it moves fast; open an issue
before a large change so we can agree the shape first.

## Setup

```bash
mise install && pnpm install
cd packages/app && node server.mjs      # http://localhost:5200, with hot reload
```

## Before you open a pull request

```bash
pnpm typecheck && pnpm test && pnpm lint
```

CI runs the same gates on macOS and Linux. For UI changes, `pnpm test:e2e` runs the browser suite
(`npx playwright install chromium` first) and a screenshot in the pull request helps.

## Ground rules

- **`core` has zero runtime dependencies.** CI fails if that changes.
- **Every performance claim traces to [`bench/RESULTS.md`](bench/RESULTS.md).** Change a number,
  show the run.
- **No model call on the recall path.**
- **Local only.** Nothing new may listen beyond loopback or send data anywhere without being
  opt-in and documented in the README.
- **Nothing personal in the repo.** Test fixtures use made-up people and `example.com`; your own
  settings belong in gitignored `*.local.json` files.
