-- ===========================================================================================
-- The relay's database half: two tables that carry sealed messages between a Mac and its phone.
--
-- This is the backing store for packages/app/relay-transport.mjs, and it is derived from that
-- file rather than from an idea of what a relay table should hold. The transport asks a database
-- for exactly two things:
--
--     db.send(room, dir, envelope)        put one sealed message in the pipe
--     db.subscribe(room, dir, onMessage)  hear the ones addressed this way, from now on
--
-- `envelope` is what sealed-envelope.mjs produces and nothing else: { v, dir, seq, n, ct }. Those
-- five fields are the columns below. There is no sixth, because a sixth would be a field this
-- database was given that the Mac and the phone did not agree to hand it.
--
-- Apply with one command against a project you have linked:
--
--     supabase db push
--
-- Nothing in this repo creates a project, holds a key, or opens a connection to one. That is the
-- user's call and this file does not make it.
--
--
-- ---------------------------------------------------------------------------------------------
-- WHAT SOMEONE WITH FULL READ ACCESS TO THIS DATABASE LEARNS
-- ---------------------------------------------------------------------------------------------
--
-- Assume the worst reader: the provider, a leaked service key, a subpoena, a backup on a desk.
-- They can `select *` from both tables. Here is the whole of what that is worth to them.
--
--   They learn HOW MANY messages there were, and WHEN each one arrived, to the microsecond.
--     created_at is a real timestamp and traffic analysis is real. A burst of forty messages at
--     23:40 says someone was working late. We do not pretend otherwise.
--
--   They learn ROUGHLY HOW BIG each message was.
--     Not exactly: sealed-envelope.mjs pads every plaintext up to 256, 1K, 4K, 16K, 64K and then
--     64K blocks before sealing, so octet_length(ct) is a band, not a fact. A one-word reply and
--     a yes are the same size here.
--
--   They learn WHICH ROOM WAS BUSY, and which way each message travelled.
--     `room` is HKDF-SHA256 of the pairing secret (relayKeys, sealed-envelope.mjs) and is one-way
--     out of a secret this database was never given. It names no machine, no person and no
--     network. It also changes every time the Mac's agent host restarts, because the pairing
--     secret is that launch's token — so a room id is a session, not an identity.
--
--   They learn WHICH ACCOUNT a room belongs to, and through auth.users, that account's email.
--     This is the one thing above the line drawn in sealed-envelope.mjs, it is deliberate, and it
--     is what `owner` costs. RLS has to hang off something the database can check, and an account
--     is the only thing a phone in another country can present. The consequence is worth stating
--     plainly: `owner` is what makes this week's room linkable to last week's. The room id alone
--     is not, and without `owner` a reader would see a new unrelated room every launch.
--     The alternative was RLS by proof-of-knowledge of the room id, and it is worse: it means the
--     anon key plus a room id is enough to read a room, and the room id then has to travel in a
--     header on every request, where it is one log line away from being a permanent credential in
--     somebody's proxy. An account that can be revoked beats a secret that cannot.
--
-- And here is what they DO NOT learn, which is the point:
--
--   Not one byte of the fleet. No chat title, no message text, no repo name, no branch, no file
--   path, no command, no model name, no token, no machine name, no hostname, no local IP, no
--   route, no HTTP method, no status code. `ct` is AES-256-GCM under a key HKDF'd from a secret
--   that lives only on the Mac that minted it and the phone that scanned the QR, and that dies
--   when the host restarts. There is no column here that could hold any of it, and that is not an
--   accident of what we happened to store — it is the check to run on any future migration. If a
--   column, an index or a constraint name in this schema ever tells a reader what a person was
--   working on, the schema is wrong and this note is the thing it is wrong against.
--
-- With WRITE access, they can do three things, all of them accounted for upstream:
--   insert rows        — refused by the seal; the Mac reads them as unreadable and counts them,
--                        which is what the pairing panel shows as "N messages this Mac could not
--                        read". The keys are per-direction, so our own traffic cannot be bounced
--                        back at us as a command.
--   edit a row         — the header (v, dir, seq) is the AAD, so editing it breaks the seal rather
--                        than redirecting a message. Editing `ct` breaks the tag.
--   delete rows        — denial of service, which is indistinguishable from the relay being
--                        unreachable, which the transport already survives: the phone retries, the
--                        same as it does on a flaky LAN.
--
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THE TRANSPORT WANTS THAT THIS SCHEMA CANNOT GIVE IT
-- ---------------------------------------------------------------------------------------------
--
-- Four of them. They are written down rather than papered over with an invented field.
--
-- 1. "Delivered" is not a state this database can know. `db.subscribe` has no ack — a reader is
--    handed an envelope and says nothing back — so no column here can honestly mean `delivered`.
--    Retention is therefore by AGE, not by delivery, and the age is not a guess: see below.
--    The DELETE policy does let a reader delete a row it has opened, so an adapter that wants
--    delete-on-read may have it; the transport as written never calls it.
--
-- 2. Realtime cannot carry a large message. The transport's body ceiling is 30 MB (MAX_BODY) and
--    a `ct` of that size inserts here fine, but Supabase Realtime drops a postgres_changes payload
--    over its record limit (~1 MB, and less in practice). So the adapter needs either a fetch-by-id
--    fallback when it sees a truncated payload, or a chunking layer. Neither is invented here,
--    because both are the adapter's shape and the adapter is not written yet.
--
-- 3. `subscribe(room, dir, …)` is two equalities and postgres_changes accepts one. That one is
--    solvable and is solved: `pipe` is a stored generated column holding `room || ':' || dir`, so
--    the subscription filter is `pipe=eq.<room>:<dir>` and no message is fanned out to a listener
--    that then has to discard it.
--
-- 4. Nothing here resends. A phone that loses signal mid-stream loses the chunks that arrived
--    while it was gone, because Realtime is "from now on" and this table's memory is 150 seconds.
--    The transport's answer is the same as on the LAN: the phone asks again.
--
--
-- ---------------------------------------------------------------------------------------------
-- RETENTION: 150 SECONDS, AND WHY THAT EXACT NUMBER
-- ---------------------------------------------------------------------------------------------
--
-- A relay that keeps a permanent log of ciphertext is a liability nobody asked for, so this one
-- keeps none. Messages are deleted once they are older than 150 seconds.
--
-- That number is not a taste. createOpener refuses any message whose sealed timestamp is more than
-- DEFAULT_MAX_AGE_MS (120s) old, and allows FUTURE_SLACK_MS (30s) of clock skew the other way. A
-- row older than 150 seconds can therefore never be opened by anybody, ever, by construction. It
-- is not data any more; it is a size and a timestamp. So it goes.
--
-- The window is enforced twice, because a retention promise that depends on an optional extension
-- is not a promise:
--   * a statement trigger on insert, which makes the sweep part of the traffic itself and needs
--     nothing installed; and
--   * a pg_cron job every 30 seconds, which sweeps a room that has gone quiet and so has no more
--     inserts to ride on.
-- Worst case a ciphertext sits here about three minutes: 150 seconds plus a sweep interval. Rooms
-- themselves are deleted after 24 hours without a heartbeat, taking their messages with them.
-- ===========================================================================================


-- ------------------------------------------------------------------------ where these live ----
--
-- In `public`, prefixed, rather than in a `relay` schema of their own. A custom schema is the
-- tidier answer and it was the first one written here, but it is not reachable through PostgREST
-- until someone adds it to the project's exposed schemas in the dashboard — and the brief for this
-- work is that applying it is one command, not one command and a settings page. The cost of living
-- in `public` is that Supabase's default privileges there hand new tables to `anon`, so that grant
-- is revoked below, out loud, where a test can check it. To move these into their own schema
-- later: create it, `alter table … set schema relay`, and add `relay` to the exposed schemas.

create table if not exists public.relay_room (
  -- the room id from relayKeys(): 16 bytes of HKDF-SHA256, hex. One per paired Mac, per launch.
  id text primary key
    constraint relay_room_id_is_a_room_id check (id ~ '^[0-9a-f]{32}$'),

  -- the signed-in account. Everything in this file that keeps one person's rows away from
  -- another's comes back to this column.
  owner uuid not null default auth.uid()
    references auth.users (id) on delete cascade,

  created_at timestamptz not null default now(),

  -- the Mac says "still here" by touching this; a room not touched for a day is swept, along with
  -- anything in it. Stamped by a trigger, so a client cannot park one in the future to keep it.
  last_seen_at timestamptz not null default now(),

  -- what the composite foreign key on relay_message points at. It is the reason a message cannot
  -- be attached to a room its author does not own — not a policy, a key.
  constraint relay_room_id_owner_key unique (id, owner)
);

comment on table public.relay_room is
  'One paired Mac, for one launch of its agent host. The id is HKDF of the pairing secret and names no machine; `owner` is the account both devices signed in as. Holds nothing about the fleet — see the threat note in this table''s migration.';

create table if not exists public.relay_message (
  id bigint generated always as identity primary key,

  room text not null,

  -- carried on every message as well as on the room, so that RLS is one equality on this table and
  -- the composite FK below can do the rest structurally.
  owner uuid not null default auth.uid(),

  -- sealed-envelope.mjs: TO_MAC / TO_PHONE. The database cannot tell a Mac from a phone — both
  -- hold the same account — and does not need to: a message sealed m2p can only be opened with the
  -- phone's key, so the direction is enforced by the cryptography and merely routed by this column.
  dir text not null
    constraint relay_message_dir_is_a_direction check (dir in ('p2m', 'm2p')),

  -- envelope.v. The opener refuses anything that is not VERSION, but a version that cannot be
  -- stored is a version that cannot be rolled out, so the column is wider than the check.
  v smallint not null default 1
    constraint relay_message_v_is_positive check (v > 0),

  -- envelope.seq, 1..MAX_SEQ. Cleartext by design: it is part of the AAD, so it is authenticated
  -- but not hidden, and the pipe is allowed to see it because the pipe has to route on it.
  seq bigint not null
    constraint relay_message_seq_in_range check (seq between 1 and 4294967295),

  -- envelope.n: 12 nonce bytes, base64url, which is exactly 16 characters and never any other
  -- number of them.
  nonce text not null
    constraint relay_message_nonce_is_a_nonce check (nonce ~ '^[A-Za-z0-9_-]{16}$'),

  -- envelope.ct: the sealed body plus its 16-byte tag, base64url. The ceiling is the transport's
  -- 30 MB MAX_BODY with room for base64 and padding, so a body the transport would accept is a row
  -- this table will take, and one it would refuse is one this table refuses too. No regex: a
  -- character-class scan over 40 MB on every insert would cost more than it is worth, and a `ct`
  -- that is not valid base64url fails to open, which is already the answer to every other kind of
  -- rubbish in this column.
  ct text not null
    constraint relay_message_ct_has_a_size check (octet_length(ct) between 1 and 41943040),

  -- stamped by a trigger rather than trusted from the client, because this is what the sweep reads
  -- and a row with a created_at in the future would be a row that never expires.
  created_at timestamptz not null default now(),

  -- the single equality postgres_changes can filter on. See note 3 in the header.
  pipe text generated always as (room || ':' || dir) stored,

  -- a message belongs to a room, and to the same account as that room. Both halves in one key: a
  -- client cannot write into a room it does not own even if every policy below were dropped.
  constraint relay_message_room_fkey foreign key (room, owner)
    references public.relay_room (id, owner) on delete cascade,

  -- the same envelope twice is refused by the pipe, not just by the opener's replay window. The
  -- two windows line up on purpose: this index only constrains live rows, and a row old enough to
  -- have been swept is old enough that its sealed timestamp is stale, so the gap it leaves cannot
  -- be walked through.
  constraint relay_message_no_replays unique (room, dir, nonce)
);

comment on table public.relay_message is
  'One sealed message in flight. Ciphertext and routing; never plaintext, never anything about the fleet. Deleted 150 seconds after it arrives, which is the point past which sealed-envelope.mjs would refuse to open it anyway.';
comment on column public.relay_message.ct is
  'AES-256-GCM ciphertext under a key this database was never given. Size is padded to a bucket, so its length is a band rather than a fact.';
comment on column public.relay_message.pipe is
  'room || '':'' || dir, so a Realtime subscription is one equality filter. Derived; never set by a client.';

create index if not exists relay_room_owner_idx on public.relay_room (owner);
create index if not exists relay_room_last_seen_idx on public.relay_room (last_seen_at);

-- reading a pipe in order, which is the only read the adapter makes
create index if not exists relay_message_pipe_idx on public.relay_message (pipe, id);
-- the sweep
create index if not exists relay_message_created_at_idx on public.relay_message (created_at);
-- the composite FK's cascade, and the `owner` equality every policy below adds to every query
create index if not exists relay_message_room_owner_idx on public.relay_message (room, owner);

-- Every index in this file is on routing or on time. None is on content, because there is no
-- content column to put one on. An index named after something a person was working on would leak
-- through \d even with every policy in place.


-- ------------------------------------------------------------------------------- stamping ----
--
-- created_at and last_seen_at are ours, not the client's. A client that could set them could keep
-- a row past the sweep, which is the only way to turn this table into the permanent log it is not
-- supposed to be. They cannot be CHECK constraints: now() is not immutable.

create or replace function public.relay_stamp_message()
  returns trigger language plpgsql set search_path = '' as $$
begin
  new.created_at := now();
  return new;
end;
$$;

create or replace function public.relay_stamp_room()
  returns trigger language plpgsql set search_path = '' as $$
begin
  new.last_seen_at := now();
  if tg_op = 'INSERT' then new.created_at := now(); else new.created_at := old.created_at; end if;
  return new;
end;
$$;

drop trigger if exists relay_message_stamp on public.relay_message;
create trigger relay_message_stamp
  before insert on public.relay_message
  for each row execute function public.relay_stamp_message();

drop trigger if exists relay_room_stamp on public.relay_room;
create trigger relay_room_stamp
  before insert or update on public.relay_room
  for each row execute function public.relay_stamp_room();


-- -------------------------------------------------------------------------------- the sweep ----

create or replace function public.relay_sweep()
  returns integer language plpgsql security definer set search_path = '' as $$
declare
  gone integer;
begin
  -- 120s max sealed age + 30s clock slack: past here nothing can open it. See the header.
  delete from public.relay_message where created_at < now() - interval '150 seconds';
  get diagnostics gone = row_count;
  delete from public.relay_room where last_seen_at < now() - interval '24 hours';
  return gone;
end;
$$;

comment on function public.relay_sweep() is
  'Delete every message past the age at which it could still be opened, and every room that has not said it is there for a day. Runs from a trigger on insert and from pg_cron; either alone is enough.';

-- security definer, because the sweep clears everybody's expired rows and the caller is one
-- account. The function owner (postgres) is the tables' owner and so is not subject to their RLS,
-- which is exactly the reach it needs and no more: it takes no arguments and can only delete rows
-- that are already past being readable.
revoke all on function public.relay_sweep() from public, anon, authenticated;

create or replace function public.relay_sweep_tick()
  returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- one sweeper per moment; a concurrent insert skips rather than queues behind it, so a busy room
  -- does not serialise on the sweep. Statement level, so a batch insert sweeps once.
  if pg_try_advisory_xact_lock(hashtext('relay_sweep')) then
    perform public.relay_sweep();
  end if;
  return null;
end;
$$;

revoke all on function public.relay_sweep_tick() from public, anon, authenticated;

drop trigger if exists relay_message_sweep on public.relay_message;
create trigger relay_message_sweep
  after insert on public.relay_message
  for each statement execute function public.relay_sweep_tick();

-- pg_cron is the other half: it sweeps a room that stopped sending, which the trigger cannot. It
-- is optional on purpose — the trigger already keeps the promise — so a project without it applies
-- this migration cleanly and gets a notice rather than a failure.
do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'relay: pg_cron is not available (%). The insert trigger still sweeps; a room that goes quiet keeps its last few messages until it is written to again or swept by hand with select public.relay_sweep().', sqlerrm;
end;
$$;

do $$
begin
  perform cron.unschedule('relay-sweep');
exception when others then
  null; -- no such job yet, which is the normal case on a first apply
end;
$$;

do $$
begin
  perform cron.schedule('relay-sweep', '30 seconds', 'select public.relay_sweep()');
exception when others then
  raise notice 'relay: could not schedule the sweep (%). Retention still holds through the insert trigger.', sqlerrm;
end;
$$;


-- ---------------------------------------------------------------------------------- the lock ----
--
-- Two layers, and the first one is not RLS.
--
-- Layer one is the grant. `anon` — the role a stolen publishable key speaks as — is given nothing
-- at all, so it does not reach a policy to be filtered by one; it is refused at the table. This
-- matters because a policy is a thing someone can get wrong later, and a missing grant is not.
--
-- Layer two is RLS, on the account. Every row carries `owner` and every policy is the same single
-- equality against it. A phone signed in to one account cannot see another account's rows in
-- either direction, and cannot write into them either — and for writes it is not only the policy
-- saying so, it is the composite foreign key (room, owner), which has no exception to grant.
--
-- `service_role` is not used by any of this. Normal operation — the Mac sending, the phone
-- sending, both subscribing, either deleting what it has read — is entirely within `authenticated`.
-- The service key is for nothing here, which is the way to keep it out of a phone.

revoke all on public.relay_room from public;
revoke all on public.relay_room from anon;
revoke all on public.relay_message from public;
revoke all on public.relay_message from anon;

grant select, insert, update, delete on public.relay_room to authenticated;
-- no UPDATE: a sealed message is not editable, and a policy that allowed it would be a way to
-- change a `ct` under a `seq` that had already been seen.
grant select, insert, delete on public.relay_message to authenticated;

alter table public.relay_room enable row level security;
alter table public.relay_message enable row level security;

-- The rest of this file is `if not exists`, so the policies are too: anything already on these two
-- tables is dropped and rewritten from here, which means the policies in force are always the ones
-- in this file and never a half of them left over from an earlier apply.
do $$
declare p record;
begin
  for p in
    select policyname, tablename from pg_policies
    where schemaname = 'public' and tablename in ('relay_room', 'relay_message')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end;
$$;

-- (select auth.uid()) rather than auth.uid(): wrapped in a select, the planner runs it once per
-- query instead of once per row.

create policy "a room is visible to the account that opened it"
  on public.relay_room for select to authenticated
  using (owner = (select auth.uid()));

create policy "an account may open a room, and only in its own name"
  on public.relay_room for insert to authenticated
  with check (owner = (select auth.uid()));

create policy "an account may say its own room is still there"
  on public.relay_room for update to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));

create policy "an account may close its own room"
  on public.relay_room for delete to authenticated
  using (owner = (select auth.uid()));

create policy "a message is visible to the account whose room it is in"
  on public.relay_message for select to authenticated
  using (owner = (select auth.uid()));

create policy "an account may write into its own rooms"
  on public.relay_message for insert to authenticated
  with check (owner = (select auth.uid()));

create policy "an account may delete a message it has read"
  on public.relay_message for delete to authenticated
  using (owner = (select auth.uid()));


-- -------------------------------------------------------------------------------- realtime ----
--
-- `db.subscribe` is a postgres_changes subscription on INSERT, filtered `pipe=eq.<room>:<dir>`.
-- Realtime evaluates the SELECT policy above as the subscribing user, so the same one equality
-- that keeps another account out of a query keeps it out of the feed.
--
-- Default replica identity is right: only INSERT is published, and the new row is all it carries.
-- `replica identity full` would put the old row on the wire for updates and deletes, which is more
-- ciphertext in more places for no gain.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.relay_message;
  else
    raise notice 'relay: no supabase_realtime publication here; add public.relay_message to whatever publication Realtime reads.';
  end if;
exception when duplicate_object then
  null; -- already published, which is what a re-apply looks like
end;
$$;
