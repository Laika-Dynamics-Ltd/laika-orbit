# Pulse ingest

The one server-side piece of Laika Orbit: a Cloudflare Worker and a D1 database that receive
opt-in, anonymous usage counts and hand aggregates back to the `/pulse` page.

Read [`worker.js`](worker.js) before deploying it — it is short on purpose, and it is the real
boundary for what can be stored. The client is open source and runs on other people's machines,
so its allowlist is a courtesy; this one is the gate.

## Deploy

```bash
cd tools/pulse-ingest
npx wrangler d1 create laika-pulse            # copy the id into wrangler.toml
npx wrangler d1 execute laika-pulse --remote --file=schema.sql
npx wrangler secret put PULSE_READ_TOKEN      # any long random string; the dashboard uses it
npx wrangler deploy
```

Then point the app at it, in `.env.local`:

```bash
PULSE_ENDPOINT=https://laika-pulse.<your-subdomain>.workers.dev
PULSE_READ_TOKEN=<the same string>
```

`PULSE_ENDPOINT` is what lets a build report at all; without it the client is inert whatever the
user's consent says. `PULSE_READ_TOKEN` is only needed on *your* machine, to read the dashboard.

Optionally `npx wrangler secret put PULSE_WRITE_TOKEN` to close the ingest endpoint. Leave it
unset for a normal public release: opt-in reporting from users you do not control is the point.

## Routes

| | |
|---|---|
| `POST /v1/events` | a batch from one install. Validated against the allowlist, open by default. |
| `GET /v1/pulse` | aggregates for the dashboard. Needs `Authorization: Bearer $PULSE_READ_TOKEN`. |
| `GET /v1/health` | liveness. No auth, no data. |

## What it stores

Two tables, described in [`schema.sql`](schema.sql): an install row (random uuid, first and last
day, app version, platform, continent) and one counter row per install per day per event name.
No IP, no user agent, no free text, and no timestamp finer than a day. See
[`PRIVACY.md`](../../PRIVACY.md).

## Checking it

The validator runs in the repo's test suite without a Worker runtime
(`packages/app/test/pulse.test.mjs`), including the injection-shaped and wrong-clock cases.
