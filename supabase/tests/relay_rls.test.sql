-- ===========================================================================================
-- The policies, proved with real queries from the wrong identity.
--
-- The migration's claim is that a phone signed in to one account cannot read another Mac's rows,
-- that a stolen anon key gets nothing at all, and that none of it needs the service role. Those
-- are three claims about a running Postgres, so they are checked against one:
--
--     supabase start          (needs Docker; see supabase/README.md if it will not run)
--     supabase test db
--
-- Every assertion below is a query run as somebody: alice, bob, or anon. Nothing is asserted about
-- the text of the migration — that half is packages/app/test/relay-schema.test.mjs, which runs
-- anywhere and does not need a database.
--
-- The whole file is one transaction and ends in a rollback, so running it leaves nothing behind.
-- ===========================================================================================

begin;

create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- --------------------------------------------------------------------------- two accounts ----
--
-- Two people, each with a paired Mac. Alice is the one we mostly ask questions as; Bob exists so
-- that there is something she must not be able to see.

insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'alice@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'bob@example.test');

-- room ids as relayKeys() makes them: 16 bytes of HKDF, hex. These two are made up, but they are
-- the right shape, and the shape is checked.
insert into public.relay_room (id, owner) values
  ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222');

insert into public.relay_message (room, owner, dir, seq, nonce, ct) values
  ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'p2m', 1, 'AAAAAAAAAAAAAAAA', 'alice-to-her-mac'),
  ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'm2p', 1, 'BBBBBBBBBBBBBBBB', 'her-mac-back'),
  ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'p2m', 1, 'CCCCCCCCCCCCCCCC', 'bob-to-his-mac');

-- The primary key of the row alice must never see, kept somewhere she can still read it, so the
-- test can ask for that row directly rather than only counting what came back. A setting rather
-- than a temp table: a temp table belongs to the role that made it, and half of this file runs as
-- somebody else.
do $$
begin
  perform set_config('test.bobs_message',
    (select id::text from public.relay_message where room = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), true);
end;
$$;


-- ------------------------------------------------------------ what the shape of a row is ----

select is(
  (select pipe from public.relay_message where nonce = 'AAAAAAAAAAAAAAAA'),
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:p2m',
  'pipe is room and direction, which is the one equality a Realtime filter can carry');

select throws_ok(
  $$ insert into public.relay_room (id, owner) values ('not-a-room-id', '11111111-1111-1111-1111-111111111111') $$,
  '23514',
  null,
  'a room id that is not 16 bytes of hex is refused');

select throws_ok(
  $$ insert into public.relay_message (room, owner, dir, seq, nonce, ct)
     values ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'sideways', 1, 'DDDDDDDDDDDDDDDD', 'x') $$,
  '23514',
  null,
  'a direction that is neither p2m nor m2p is refused');

select throws_ok(
  $$ insert into public.relay_message (room, owner, dir, seq, nonce, ct)
     values ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'p2m', 2, 'too-short', 'x') $$,
  '23514',
  null,
  'a nonce that is not twelve base64url bytes is refused');

select throws_ok(
  $$ insert into public.relay_message (room, owner, dir, seq, nonce, ct)
     values ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'p2m', 1, 'AAAAAAAAAAAAAAAA', 'the same envelope again') $$,
  '23505',
  null,
  'the same nonce twice in one pipe is refused by the table, not only by the opener');

select ok(
  (select created_at from public.relay_message where nonce = 'AAAAAAAAAAAAAAAA') < now() + interval '1 second',
  'created_at is stamped here, so a client cannot park a row in the future to outlive the sweep');

-- a client that tries anyway
insert into public.relay_message (room, owner, dir, seq, nonce, ct, created_at)
values ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'p2m', 9, 'EEEEEEEEEEEEEEEE', 'x', now() + interval '10 years');
select ok(
  (select created_at from public.relay_message where nonce = 'EEEEEEEEEEEEEEEE') < now() + interval '1 second',
  'a created_at supplied by the client is overwritten rather than trusted');
delete from public.relay_message where nonce = 'EEEEEEEEEEEEEEEE';


-- ------------------------------------------------------------------- alice, signed in ----

set local role authenticated;
set local request.jwt.claims = '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';

select is(
  (select count(*) from public.relay_room)::int, 1,
  'alice sees her own room and no other account''s');

select is(
  (select id from public.relay_room)::text, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'and it is hers');

select is(
  (select count(*) from public.relay_message)::int, 2,
  'alice sees both directions of her own room, and nothing of Bob''s');

-- the point of the whole file: a row that exists, asked for by its exact id, from the wrong
-- identity. Not "filtered out of a list" — invisible.
select is(
  (select count(*) from public.relay_message
    where id = current_setting('test.bobs_message')::bigint)::int,
  0,
  'a message of Bob''s, asked for by primary key, does not exist as far as alice is concerned');

select is(
  (select count(*) from public.relay_message where room = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')::int, 0,
  'and neither does his room, asked for by name');

select throws_ok(
  $$ insert into public.relay_message (room, owner, dir, seq, nonce, ct)
     values ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'p2m', 2, 'FFFFFFFFFFFFFFFF', 'a message alice wrote') $$,
  '42501',
  null,
  'alice cannot write into Bob''s room in his name');

select throws_ok(
  $$ insert into public.relay_message (room, owner, dir, seq, nonce, ct)
     values ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'p2m', 2, 'FFFFFFFFFFFFFFFF', 'a message alice wrote') $$,
  '23503',
  null,
  'nor in her own name — the composite key says that room is not hers, before any policy is asked');

select throws_ok(
  $$ insert into public.relay_room (id, owner)
     values ('cccccccccccccccccccccccccccccccc', '22222222-2222-2222-2222-222222222222') $$,
  '42501',
  null,
  'alice cannot open a room that belongs to somebody else');

select lives_ok(
  $$ insert into public.relay_message (room, dir, seq, nonce, ct)
     values ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'p2m', 2, 'GGGGGGGGGGGGGGGG', 'a real message') $$,
  'alice can send into her own room without naming herself — owner defaults to who she is');

select is(
  (select owner from public.relay_message where nonce = 'GGGGGGGGGGGGGGGG'),
  '11111111-1111-1111-1111-111111111111'::uuid,
  'and it is stamped with her account, not one she chose');

select throws_ok(
  $$ update public.relay_message set ct = 'edited' where nonce = 'GGGGGGGGGGGGGGGG' $$,
  '42501',
  null,
  'nobody edits a sealed message in place, not even its author');

-- the WITH has to be the top level of the statement, not a scalar subquery inside one: a
-- data-modifying CTE is only allowed where Postgres can see it as the statement itself

with gone as (delete from public.relay_message where room = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' returning 1)
select is((select count(*) from gone)::int, 0,
  'alice deleting Bob''s messages deletes nothing');

with gone as (delete from public.relay_message where nonce = 'GGGGGGGGGGGGGGGG' returning 1)
select is((select count(*) from gone)::int, 1,
  'alice deleting her own message — delete-on-read, if an adapter ever wants it');

with touched as (update public.relay_room set last_seen_at = now()
                 where id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' returning 1)
select is((select count(*) from touched)::int, 0,
  'alice cannot keep Bob''s room alive, or reach it at all');

with touched as (update public.relay_room set last_seen_at = now()
                 where id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' returning 1)
select is((select count(*) from touched)::int, 1,
  'she can say her own Mac is still there, which is the heartbeat the 24-hour sweep reads');

-- the other half of that: the heartbeat is a fact about when it happened, not a value she sets
update public.relay_room set last_seen_at = now() - interval '25 hours'
  where id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
select ok(
  (select last_seen_at from public.relay_room where id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') > now() - interval '1 minute',
  'and she cannot backdate it, nor post-date it, because the stamp is taken here');

select throws_ok(
  $$ select public.relay_sweep() $$,
  '42501',
  null,
  'and she cannot run the sweep herself, though it would only delete what is already unreadable');


-- ----------------------------------------------------------------- bob, the other account ----

set local request.jwt.claims = '{"sub": "22222222-2222-2222-2222-222222222222", "role": "authenticated"}';

select is(
  (select count(*) from public.relay_message)::int, 1,
  'bob still has his message: alice''s delete did not reach it');

select is(
  (select count(*) from public.relay_room where id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')::int, 0,
  'and the wall stands the other way round too');


-- ------------------------------------------------------------------ a stolen anon key ----
--
-- The publishable key is in the iOS app and on every phone, so treat it as public. It is refused
-- at the table rather than filtered by a policy: there is no grant to reach a policy with.

reset role;
set local role anon;
set local request.jwt.claims = '{"role": "anon"}';

select throws_ok($$ select * from public.relay_message $$, '42501', null,
  'anon cannot read a message');
select throws_ok($$ select * from public.relay_room $$, '42501', null,
  'anon cannot read a room');
select throws_ok(
  $$ insert into public.relay_message (room, owner, dir, seq, nonce, ct)
     values ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'p2m', 3, 'HHHHHHHHHHHHHHHH', 'x') $$,
  '42501', null,
  'anon cannot write a message');
select throws_ok($$ delete from public.relay_message $$, '42501', null,
  'anon cannot delete a message');
select throws_ok($$ select public.relay_sweep() $$, '42501', null,
  'anon cannot run the sweep');

reset role;

-- asked of the catalogue directly rather than through information_schema, which only shows what the
-- role running the query is entitled to see
select ok(
  not bool_or(has_table_privilege('anon', t, p)),
  'anon holds no privilege of any kind on either table — checked, not assumed')
from unnest(array['public.relay_room', 'public.relay_message']) t,
     unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references']) p;

select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename like 'relay\_%' and roles::text[] @> array['service_role'])::int,
  0,
  'no policy is written for the service role, because normal operation never needs it');

select ok(
  (select bool_and(rowsecurity) from pg_tables where schemaname = 'public' and tablename like 'relay\_%'),
  'row level security is on for both tables');


-- ------------------------------------------------------------------------- the sweep ----

-- a message old enough that sealed-envelope.mjs would refuse to open it
update public.relay_message set created_at = now() - interval '151 seconds' where nonce = 'CCCCCCCCCCCCCCCC';

select is(
  (select public.relay_sweep())::int, 1,
  'the sweep takes a message past the age at which it could still be opened');

select is(
  (select count(*) from public.relay_message where nonce = 'CCCCCCCCCCCCCCCC')::int, 0,
  'and it is gone');

select is(
  (select count(*) from public.relay_message where nonce = 'AAAAAAAAAAAAAAAA')::int, 1,
  'while a message still inside the window stays');

-- the same thing again, but swept by the traffic rather than by cron: nothing is scheduled here
update public.relay_message set created_at = now() - interval '151 seconds' where nonce = 'AAAAAAAAAAAAAAAA';
insert into public.relay_message (room, owner, dir, seq, nonce, ct)
values ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'm2p', 2, 'IIIIIIIIIIIIIIII', 'a later message');

select is(
  (select count(*) from public.relay_message where nonce = 'AAAAAAAAAAAAAAAA')::int, 0,
  'an insert sweeps too, so retention does not depend on pg_cron being installed');

-- And a room that stopped saying it was there. The stamp trigger has to come off to do this: it
-- refuses to let last_seen_at be anything but now(), which is exactly what the assertion in the
-- alice section proves a client cannot get around. Here we are simulating a day passing, not a
-- client lying about one.
alter table public.relay_room disable trigger relay_room_stamp;
update public.relay_room set last_seen_at = now() - interval '25 hours' where id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
alter table public.relay_room enable trigger relay_room_stamp;
insert into public.relay_message (room, owner, dir, seq, nonce, ct)
values ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'p2m', 4, 'JJJJJJJJJJJJJJJJ', 'x');
do $$ begin perform public.relay_sweep(); end; $$;

select is(
  (select count(*) from public.relay_room where id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')::int, 0,
  'a room idle for a day is swept');

select is(
  (select count(*) from public.relay_message where room = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')::int, 0,
  'and takes its messages with it, on the way out');


-- --------------------------------------------------------------------------- realtime ----

select is(
  (select count(*) from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'relay_message')::int,
  1,
  'relay_message is published, which is what makes db.subscribe a subscription and not a poll');

select is(
  (select count(*) from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'relay_room')::int,
  0,
  'relay_room is not, because nothing subscribes to it and every published row is a row on a wire');


select * from finish();
rollback;
