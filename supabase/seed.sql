-- Bob local dev fixture data -- DEV ONLY, never applied to a hosted project.
--
-- `supabase/config.toml` already declares this file under `[db.seed] sql_paths`,
-- so it runs automatically after the migrations on `npx supabase db reset` (and
-- on the first `supabase start` of a fresh volume). It executes as the database
-- superuser BEFORE the app is up, so it never calls the API, never signs anyone
-- in, and never touches the email provider -- which is off locally.
--
-- Signing in: the local email provider is disabled (`enable_signup = false`
-- under `[auth.email]`, and there is no config key that separates sign-IN from
-- signup), so `dev@bob.local` is signed in with an ADMIN-GENERATED LINK.
-- docs/deploy.md "Signing in locally" carries the exact request.
--
-- IDEMPOTENCE, and why the dev account is the one special case.
-- Two mechanisms create `dev@bob.local` and they disagree about its id: this
-- file would assign a fixed uuid, while scripts/dev-offline.mjs
-- `ensureDevUser()` gets a RANDOM one from the auth admin API. auth.users is
-- unique on EMAIL (users_email_partial_key), so `on conflict (id) do nothing`
-- cannot catch that collision -- against a database that already holds the
-- account it dies with "duplicate key value violates unique constraint
-- users_email_partial_key". Therefore:
--   * the auth user is guarded on EMAIL (`where not exists`). An account that
--     is already there keeps its own id, metadata and display name, untouched;
--     the fixed uuid below applies only when this file creates the account.
--   * every other row is keyed by a FIXED uuid with `on conflict (id) do
--     nothing`, and takes its owner from the RESOLVED account id rather than a
--     hard-coded one, so the fixture attaches to whichever dev account exists.
-- Running this file twice in a row is a no-op the second time, and running it
-- against a database that is not brand new is not an error.
--
-- Further rules for anything added here:
--   * Every date derives from `current_date` / `now()` -- a fixture that goes
--     stale is worse than no fixture at all.
--   * No real credential, token or password. The dev user has no password.
--
-- The fixture ids, so a reset never moves them:
--   spaces   22222222-...  Home (group)   33333333-...  Private (private)
--   conversation 44444444-...  Weekend plan (messages 44444444-...01..03)
--   tasks    55555555-...01..04   notes  66666666-...01..02
--   calendar 77777777-...  event  88888888-...
-- The dev account's id is deliberately NOT on that list: it is resolved at run
-- time. 11111111-1111-4111-8111-111111111111 is merely the id this file hands
-- out when it is the one creating the account.

-- 1. The dev account, in the columns GoTrue's admin API populates.
--    encrypted_password stays null: sign-in is by admin-generated link, so
--    there is no password to invent and none is ever written down.

insert into auth.users (
  instance_id, id, aud, role, email,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new
)
select
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-4111-8111-111111111111',
  'authenticated',
  'authenticated',
  'dev@bob.local',
  now(),
  '{"provider": "email", "providers": ["email"]}'::jsonb,
  '{"name": "Dev User"}'::jsonb,
  now(),
  now(),
  '', '', '', ''
where not exists (select 1 from auth.users where email = 'dev@bob.local')
on conflict (id) do nothing;

-- The matching identity row: GoTrue's email provider expects one, and without
-- it the account cannot be resolved by email. `user_id` and `provider_id` are
-- the RESOLVED id, so this follows an admin-API account as readily as one this
-- file created. `auth.identities.email` is a generated column
-- (lower(identity_data->>'email')), so it is not listed. The identity's own id
-- is generated rather than fixed: nothing references it, and the guard means
-- the row is inserted at most once.

insert into auth.identities (
  id, user_id, provider, provider_id, identity_data, created_at, updated_at
)
select
  gen_random_uuid(),
  u.id,
  'email',
  u.id::text,
  jsonb_build_object(
    'sub', u.id::text,
    'email', u.email,
    'email_verified', true,
    'phone_verified', false
  ),
  now(),
  now()
from auth.users u
where u.email = 'dev@bob.local'
  and not exists (
    select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email'
  );

-- 2. Spaces. Both kinds the UI renders: one `group` (shareable, renameable) and
--    the `private` space the app creates per account. Each needs an ACTIVE
--    owner membership -- RLS decides access through space_memberships, so a
--    space without one is invisible to its own owner.
--
--    From here on every statement opens with the same `dev` CTE. It resolves
--    the account id ONCE per statement from the email, which is the only stable
--    key, and a cross join puts it on every fixture row. If the account is
--    somehow missing the CTE is empty and the statement inserts nothing rather
--    than creating rows owned by a uuid nobody holds.

with dev as (select id from auth.users where email = 'dev@bob.local')
insert into bob.spaces (id, kind, name, owner_user_id, created_at, updated_at)
select v.id, v.kind, v.name, dev.id, now(), now()
from dev
cross join (values
  ('22222222-2222-4222-8222-222222222222'::uuid, 'group',   'Home'),
  ('33333333-3333-4333-8333-333333333333'::uuid, 'private', 'Private')
) as v (id, kind, name)
on conflict (id) do nothing;

with dev as (select id from auth.users where email = 'dev@bob.local')
insert into bob.space_memberships (id, space_id, user_id, role, joined_at, revoked_at)
select v.id, v.space_id, dev.id, 'owner', now(), null
from dev
cross join (values
  ('22222222-2222-4222-8222-2222222222a1'::uuid, '22222222-2222-4222-8222-222222222222'::uuid),
  ('33333333-3333-4333-8333-3333333333a1'::uuid, '33333333-3333-4333-8333-333333333333'::uuid)
) as v (id, space_id)
on conflict (id) do nothing;

-- 3. One conversation in Home with three messages. `author_user_id` NULL (role
--    'assistant') is how the app marks a message from Bob, so `from_dev`
--    below decides per row; `last_sequence` stays in step with the highest
--    message sequence, client_message_id is unique per author, and each
--    message's text is its one selected version.

with dev as (select id from auth.users where email = 'dev@bob.local')
insert into bob.conversations (
  id, user_id, space_id, created_by, title, last_sequence, created_at, updated_at
)
select
  '44444444-4444-4444-8444-444444444444',
  dev.id,
  '22222222-2222-4222-8222-222222222222',
  dev.id,
  'Weekend plan',
  3,
  now() - interval '2 hours',
  now()
from dev
on conflict (id) do nothing;

with dev as (select id from auth.users where email = 'dev@bob.local'),
v (id, from_dev, body, sequence, client_message_id, age) as (values
  (
    '44444444-4444-4444-8444-444444444401', true,
    'Can someone grab milk on the way back?',
    1::bigint, 'dev-seed-weekend-1', interval '2 hours'
  ),
  (
    '44444444-4444-4444-8444-444444444402', false,
    'Added "Grab milk" to the Home list, due today.',
    2, 'dev-seed-weekend-2', interval '119 minutes'
  ),
  (
    '44444444-4444-4444-8444-444444444403', true,
    'Perfect, thanks. I will do the bins tonight.',
    3, 'dev-seed-weekend-3', interval '118 minutes'
  )
),
msg as (
  insert into bob.messages (
    id, conversation_id, space_id, role, user_id, author_user_id, position, sequence,
    client_message_id, created_at, updated_at
  )
  select
    v.id,
    '44444444-4444-4444-8444-444444444444',
    '22222222-2222-4222-8222-222222222222',
    case when v.from_dev then 'user' else 'assistant' end,
    dev.id,
    case when v.from_dev then dev.id end,
    (v.sequence - 1)::integer,
    v.sequence,
    v.client_message_id,
    now() - v.age,
    now() - v.age
  from dev cross join v
  on conflict (id) do nothing
  returning id, user_id, space_id, created_at
)
insert into bob.message_versions (
  id, message_id, user_id, space_id, parts, version_index, is_selected, created_at
)
select
  'ver_' || msg.id,
  msg.id,
  msg.user_id,
  msg.space_id,
  jsonb_build_array(jsonb_build_object('type', 'text', 'text', v.body)),
  0,
  true,
  msg.created_at
from msg
join v on v.id = msg.id
on conflict do nothing;

-- 4. Four tasks in Home, one per state the task UI branches on: due today,
--    overdue, no due date, already completed. `order_key` is NOT NULL and
--    decides list order, so the keys sort the way the rows are written.
--    `completed_by` follows `completed_at`, so only the finished task carries
--    one and it is the resolved account, never a hard-coded id.

with dev as (select id from auth.users where email = 'dev@bob.local')
insert into bob.tasks (
  id, space_id, title, body, status, due_date, order_key, created_by,
  completed_at, completed_by, created_at, updated_at
)
select
  v.id,
  '22222222-2222-4222-8222-222222222222',
  v.title,
  v.body,
  v.status,
  v.due_date,
  v.order_key,
  dev.id,
  v.completed_at,
  case when v.completed_at is not null then dev.id end,
  now() - v.age,
  coalesce(v.completed_at, now() - v.age)
from dev
cross join (values
  (
    '55555555-5555-4555-8555-555555555501'::uuid, 'Grab milk',
    null::text, 'open', current_date, 'a0', null::timestamptz, interval '0 days'
  ),
  (
    '55555555-5555-4555-8555-555555555502'::uuid, 'Pay the water bill',
    null, 'open', current_date - 2, 'a1', null, interval '0 days'
  ),
  (
    '55555555-5555-4555-8555-555555555503'::uuid, 'Book the school-run swap',
    'No date yet -- ask at pickup.', 'open', null, 'a2', null, interval '0 days'
  ),
  (
    '55555555-5555-4555-8555-555555555504'::uuid, 'Take the bins out',
    null, 'completed', null, 'a3', now() - interval '1 day', interval '2 days'
  )
) as v (id, title, body, status, due_date, order_key, completed_at, age)
on conflict (id) do nothing;

-- 5. Two notes in Home, one pinned, so the pinned-first ordering has something
--    to order. Nothing here is ever credential-shaped.

with dev as (select id from auth.users where email = 'dev@bob.local')
insert into bob.notes (
  id, space_id, title, body, pinned, created_by, updated_by, created_at, updated_at
)
select
  v.id,
  '22222222-2222-4222-8222-222222222222',
  v.title,
  v.body,
  v.pinned,
  dev.id,
  dev.id,
  now() - v.age,
  now() - v.age
from dev
cross join (values
  (
    '66666666-6666-4666-8666-666666666601'::uuid, 'Weekend checklist',
    E'- Bins out Sunday night\n- Swimming kit in the hall cupboard\n- Water the plants',
    true, interval '3 days'
  ),
  (
    '66666666-6666-4666-8666-666666666602'::uuid, 'Bin day',
    'Recycling on Tuesday, general waste on Friday.',
    false, interval '1 day'
  )
) as v (id, title, body, pinned, age)
on conflict (id) do nothing;

-- 6. A calendar and one timed event a couple of days out, so the Agenda tab is
--    not empty. A timed event carries start_at/end_at and leaves start_date/
--    end_date null (bob.calendar_events CHECKs tie all_day to which pair is
--    set). The zone is UTC so the fixture reads the same on every machine.

with dev as (select id from auth.users where email = 'dev@bob.local')
insert into bob.calendars (id, space_id, name, zone, origin, created_by, created_at, updated_at)
select
  '77777777-7777-4777-8777-777777777777',
  '22222222-2222-4222-8222-222222222222',
  'Home',
  'UTC',
  'native',
  dev.id,
  now(),
  now()
from dev
on conflict (id) do nothing;

with dev as (select id from auth.users where email = 'dev@bob.local')
insert into bob.calendar_events (
  id, calendar_id, space_id, uid, organizer_user_id, title, location,
  all_day, start_at, end_at, zone, created_at, updated_at
)
select
  '88888888-8888-4888-8888-888888888888',
  '77777777-7777-4777-8777-777777777777',
  '22222222-2222-4222-8222-222222222222',
  'dev-seed-event-1',
  dev.id,
  'Swimming lesson',
  'Leisure centre',
  false,
  ((current_date + 2) + time '18:00') at time zone 'UTC',
  ((current_date + 2) + time '19:00') at time zone 'UTC',
  'UTC',
  now(),
  now()
from dev
on conflict (id) do nothing;
