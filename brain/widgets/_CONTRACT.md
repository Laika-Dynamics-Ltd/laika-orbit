# Widget contract

Every widget is one JSON file in `brain/widgets/`. The app reads the directory and renders
whatever it finds — so **adding a widget is adding a file**, and any producer that can write
JSON is a first-class integration. No code change, no rebuild.

```jsonc
{
  "id": "calendar",              // unique; also the filename
  "kind": "list",                // calendar | metric | table | deck | applist | list | feed | links | summary
  "title": "Calendar",
  "icon": "calendar",            // optional title glyph; defaults by kind (see Icons)
  "source": "google-calendar",   // free text, shown in the footer
  "refreshedAt": "2026-09-16T02:10:00Z",
  "href": "https://calendar.google.com",   // optional: title becomes a link
  "span": 1,                     // optional grid columns, 1-3
  "config": {},                  // kind-specific (e.g. clock zones)
  "items": [
    { "title": "Sam/Alex Catchup", "meta": "12:00 – 13:00", "tag": "today",
      "at": "2026-09-16T00:00:00Z", "href": "https://...", "accent": "#ff7a45",
      "icon": "mail" }            // optional; applist tiles show it, else the title's initial
  ]
}
```

## Producers

**Three ways to fill a widget, all writing the same shape:**

1. **An agent with connectors.** Claude Code has Gmail/Calendar/Drive/Sentry/Vercel
   authorised at the *session* level — the app server does not. So Claude writes these files.
   Put it on a cron with the `schedule` skill and the widgets refresh unattended, with no OAuth
   anywhere in this codebase.
2. **A direct API integration.** Any script or service that can `POST /api/widgets/<id>`
   or write the file. Graduate a widget from (1) to (2) without touching the UI.
3. **By hand.** A links widget or a note is just a file you edit.

## API

- `GET  /api/widgets` — all widgets, newest `refreshedAt` first
- `GET  /api/widgets/:id` — one widget
- `POST /api/widgets/:id` — upsert (body = the object above). This is the integration surface
  for anything outside this repo.

`refreshedAt` drives the staleness indicator; a widget older than its `config.staleAfterMins`
(default 60) is flagged in the UI rather than quietly showing old data as if it were current.

## Icons

`icon` names a glyph from [`packages/app/src/glyphs.ts`](../../packages/app/src/glyphs.ts):
`apps` `calendar` `mail` `bolt` `clock` `brain` `chart` `gauge` `doc` `deploy` `chat` `link`
`list` `play`. An unknown key is ignored rather than rendered as a broken image.

- **Widget title** — `icon` on the widget. If absent, the kind decides: applist → `apps`,
  calendar → `calendar`, metric → `chart`, table → `clock`, deck → `bolt`, feed → `chat`,
  links → `link`, list → `list`.
- **Applist tiles** — `icon` on each item. If absent, the tile shows the item's first letter.
  It never renders empty; it used to, because this field did not exist.

## Actions

`actions` puts buttons in a widget's header, right-aligned before its age:

```jsonc
"actions": [
  { "label": "index", "action": "brain-window" },         // handled by the app
  { "label": "open", "href": "https://calendar.google.com" } // opens a link
]
```

Known `action` values: `brain-window` (opens the Brain index window). An unknown action
renders as a button that does nothing, so a widget file can name one before the app ships it.

## Summary

`summary.json` is written by the chat host's summary routine (`packages/app/summary.mjs`) at the
top of each hour and when away mode ends; it is git-ignored. `config.summary` holds the page
(needs you, running with ETAs, finished, auto-approved and recovered), `config.recap` the last time
away while it is under 12 hours old, and `config.nextAt` when the next one is written. Its `now`
action (`summary-now`) writes one straight away.

## Calendar events

The calendar widget turns each item into a real time in `config.home` so it can count down
and dim what has passed. It reads `at` (ISO) when present. Otherwise it reads `meta` as
`[Weekday ]h[:mm][am|pm]`, e.g. `"12:00pm"` or `"Thu 3:30pm"`. A bare time means today, or
tomorrow when `tag` is `"tomorrow"`; a weekday means its next occurrence, today included.
Prefer `at`: it is exact across midnight and daylight-saving changes.

## Settings (the gear)

Each widget header has a gear. What a person sets there is saved to
`brain/widgets/_settings.json`, keyed by widget id, and merged over the widget file when it
is served. Producers never write that file, so a refresh keeps the person's choices.

```jsonc
{
  "calendar": {
    "order": 20, "rail": "left", "collapsed": true, "hidden": false,
    "title": "Today", "href": "https://…", "maxItems": 5,
    "config": { "staleAfterMins": 30, "home": "Pacific/Auckland",
                "workday": { "from": 8, "to": 18 },
                "zones": [{ "label": "LONDON", "tz": "Europe/London" }] }
  }
}
```

`PATCH /api/widget-settings` with `{ "<id>": { …partial… } }` merges; a `null` value removes
that one setting, and `{ "<id>": null }` resets the widget. It is local-only. Files starting with
`_` in this folder are never served as widgets.
