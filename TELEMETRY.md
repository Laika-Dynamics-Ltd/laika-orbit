# Telemetry and user signals — for legal review

> **Status: not switched on. Needs sign-off from Laika Dynamics' lawyer before the public release.**
> Nothing below is collected today. The Users panel in Orbit reads only the sources marked *live*.

This is every signal the Users panel can show, where it comes from, what is kept, and what has to
happen before it may run. [`PRIVACY.md`](PRIVACY.md) is the user-facing version for the app; the
site's privacy page is `laika-orbit-site/src/pages/legal/privacy.astro`.

## The signals

| Step in the panel | Source | Who it's about | What's kept | State |
|---|---|---|---|---|
| Visited site | Page-view beacon on laikaorbit.com → pulse worker `/v1/hit` | Site visitors | A daily count per (page path, referring host, country). No id, no IP, no cookie, no user agent. | Built, **not deployed** |
| Joined waitlist | Resend audience "Laika Orbit" | People who signed up | Resend already holds their email. Orbit reads it on Joe's Mac, hashes it with a local salt, and drops the address. | **Live** (0 sign-ups so far) |
| Bought Pro | Stripe checkout sessions | Customers | Stripe already holds this. Orbit reads the time and the email (hashed as above), read-only. | **Live** (0 purchases so far) |
| Activated licence | The site's licence check writes `activated_at` and `last_check_day` on the Stripe subscription | Pro customers | Two metadata fields on the customer's own subscription: first check time, and the day of the latest check | Built, **not deployed** |
| Opened the app (Pro) | The same licence check (the app checks in at most hourly) | Pro customers | As above: the last day the app checked in | Built, **not deployed** |
| Opened the app / used features (free) | Opt-in telemetry (`packages/app/pulse-client.mjs`) → pulse worker `/v1/events` | Users who said yes | A random install id, app version, platform, daily counts of 13 coarse events, and a **continent** | Built, **off by default**, worker not deployed |

The panel never shows an email, a name, an IP, a customer id or an install id. Its ids are
salted hashes made on the operator's Mac.

## Opt-in telemetry: exactly what is sent

Only after the user presses "Turn it on" on the consent card (`packages/app/src/pulse-consent.ts`),
and only in a build with `PULSE_ENDPOINT` set:

```json
{
  "v": 1,
  "install": "9f1c2e4a-…",            // random uuid, made at opt-in, tied to no account
  "app": "0.42",                       // app version
  "platform": "darwin",
  "events": [
    { "day": "2026-09-18", "name": "app_open",   "count": 3 },
    { "day": "2026-09-18", "name": "recall_run", "count": 40 }
  ]
}
```

The event names allowed, by the client and again by the worker: `app_open`, `session_start`,
`map_open`, `recall_run`, `chat_open`, `chat_message`, `browser_open`, `widget_open`,
`index_rebuild`, `offload_run`, `settings_open`, `progress_open`, `pulse_open`.

The worker also derives a **continent** (OC, EU, NA…) from Cloudflare's country header on the
request and stores it against the install. The raw country and the IP are not stored.

Never sent, with no code path that could: file names, paths, search queries, recall results, chat
text, prompts, model names, email, calendar entries, browser URLs, account names, hostnames, IP
addresses, or any time finer than a day.

Defaults: *unset* behaves as *off*. Declining creates no id. Turning it off deletes the id and
anything queued.

## Questions for the lawyer

1. **Opt-in telemetry.** Is the consent card's wording enough as consent for an anonymous install
   id plus daily event counts? Does the install id count as personal data given it is random and
   unlinked?
2. **Continent.** The worker stores a continent per install. `PRIVACY.md` does not mention it.
   Either add it to `PRIVACY.md` and the consent card, or remove it from `worker.js`. Which?
3. **Licence check-ins.** Recording the first activation time and the last day the app checked in,
   on the customer's Stripe subscription, is new processing of customer data. The site's privacy
   page lists Stripe as a processor but does not say licence checks are recorded. What wording is
   needed, and does the terms page need a line?
4. **Page-view beacon.** The site's privacy page already promises "aggregate, cookie-free page
   statistics (page views, referrers, country)". The beacon keeps exactly that, runs through a
   Cloudflare Worker (not named on the privacy page), and honours Global Privacy Control and Do
   Not Track. Should Cloudflare be named as a processor?
5. **Joining waitlist to purchase.** Orbit joins a waitlist sign-up to a later purchase by hashing
   the email on the operator's Mac. The data already sits with Resend and Stripe. Is the join
   itself something the privacy page must disclose?
6. **Where the operator's view runs.** The panel reads these sources on Joe's Mac with read-only
   keys kept in the macOS Keychain. Anything to add about who inside Laika Dynamics may see it?

## Before any of it goes live

- [ ] Lawyer's answers to the six questions above, and the wording changes they ask for
- [ ] Deploy `tools/pulse-ingest` (Cloudflare Worker + D1): `wrangler d1 create`, apply `schema.sql`
      (now including the `hits` table), set `PULSE_READ_TOKEN`
- [ ] Merge and deploy `laika-orbit-site` branch `feature/users-signals`, with
      `PUBLIC_PULSE_ENDPOINT` set on Vercel (the beacon ships only when it is set)
- [ ] Set `STRIPE_SECRET_KEY` on Vercel production when sales open (the check-in write uses it)
- [ ] Only then set `PULSE_ENDPOINT` in the app build, which is what lets the consent card appear
