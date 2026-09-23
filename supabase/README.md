# The relay's database half

Two tables that carry sealed messages between a Mac and its paired phone, and the policies that
keep one account's rows away from another's. The reasoning is in the migration itself — including
the threat note, which is the part worth reading before changing anything here.

    supabase/migrations/20260924120000_relay.sql   the schema, the policies, the threat note
    supabase/tests/relay_rls.test.sql              the policies, proved with real queries
    packages/app/test/relay-schema.test.mjs        the schema, checked against the code it serves

## Applying it

There is no project. Choosing one is yours, and nothing in this repo creates one, links one, or
holds a key to one. When you have made a project:

    supabase link --project-ref <ref>
    supabase db push

That is the whole of it. The migration is idempotent, so a re-apply is safe, and it needs no
dashboard settings afterwards: the tables live in `public` precisely so that PostgREST can see
them without anyone having to add a schema to the exposed list.

Two things it will use if they are there and shrug if they are not: `pg_cron` (for the sweep that
runs when a room has gone quiet) and the `supabase_realtime` publication (for `db.subscribe`).
Both print a notice rather than failing the migration. Retention holds without either.

## Running the tests

The schema test runs anywhere, with no database:

    npx vitest run packages/app/test/relay-schema.test.mjs

The policy tests need a real Postgres, because a policy is not a claim you can check by reading:

    supabase start      # Docker, first time: it pulls images
    supabase test db
    supabase stop

**These were written but not run.** This machine has no container runtime — no Docker, no Podman,
no Colima, nothing — so `supabase start` cannot bring up a local Postgres here, and `supabase test
db` gets `ECONNREFUSED 127.0.0.1:54322`. The tests are complete and ready, and they are not
pretending to have passed. Run them once, on a machine that can, before trusting the policies with
anything real; the schema test covers the half that does not need a database, and it does pass.

What the policy tests prove, once they can run: that Bob's message asked for by its exact primary
key does not exist as far as Alice is concerned; that she cannot write into his room in his name
(policy) or in her own (the composite key, before any policy is asked); that a stolen anon key is
refused at the table rather than filtered by a policy, because it holds no privilege to reach one
with; that no policy is written for the service role; that a sealed message cannot be edited in
place by anybody; and that a message past 150 seconds is swept by the traffic itself, with pg_cron
installed or not.
