# Privacy

Laika Orbit runs on your machine. The app server listens on `127.0.0.1`, the index lives in your
folders, and recall never calls a model. Nothing in this document changes that.

There is exactly one feature that can send anything off your machine, it is **off until you turn
it on**, and it is described in full below.

## What is never sent, under any setting

File names, folder names or paths. The contents of any file. Your search or recall queries, or
their results. Chat messages, prompts or model output. Email, calendar entries or browser URLs.
Account names, email addresses or hostnames. Your IP address — the ingest endpoint does not log
it. Any timestamp finer than a calendar day.

There is no code path that sends these. The full list of what *can* be sent is the allowlist in
[`packages/app/pulse-client.mjs`](packages/app/pulse-client.mjs), and it is enforced a second
time, server-side, in [`tools/pulse-ingest/worker.js`](tools/pulse-ingest/worker.js).

## Anonymous usage reporting (opt-in)

If you turn it on, the app reports **counts of coarse actions, per day**:

| Sent | Example |
|---|---|
| A random install id | `9f1c…` — made on your Mac when you opted in, tied to no account |
| App version and platform | `0.42`, `darwin` |
| Daily counts of allowed events | `app_open: 12`, `recall_run: 40`, `chat_open: 3` |

That is the whole payload. `recall_run: 40` means recall ran forty times; it does not say what was
searched for, what was found, or which files exist.

- **Off by default.** The setting starts as *unset*, which behaves exactly like *off*.
- **Declining costs nothing.** No identifier is created unless you say yes.
- **Turning it off destroys the id** and anything queued. If you later turn it back on you come
  back as a new install, not rejoined to your old one.
- **No endpoint, no reporting.** A build without `PULSE_ENDPOINT` set cannot report at all, whatever
  the consent file says.

Your answer lives in `~/.laika/pulse/consent.json`, and anything waiting to be sent is plain JSON
in `~/.laika/pulse/outbox.json` — read them, or delete them, whenever you like.

## Public repository numbers

The `/pulse` page also shows counts GitHub already keeps about the public repo — page views,
clones, stars, forks and release downloads. These are aggregate daily numbers about the *repo*,
not about you, and reading them involves your machine not at all. On that page they are drawn as
hollow rings and labelled as cohorts, because a count of nine cloners is a count, not nine
identified people.

## The dashboard

The `/pulse` page and its window are the maintainer's view of adoption, and appear only on a
machine holding the credentials that fill them. Your copy of Laika Orbit has no such credentials,
so the button is not there and the routes behind it answer 404. Nothing about your machine is
collected in order to make that decision — it is a check of the server's own configuration.

## Changing your mind

Open `/pulse` in the app and use the reporting toggle, or:

```bash
rm -rf ~/.laika/pulse        # forget the id, the queue and every local signal
```

## Questions

Email **laika@laikadynamics.com**.
