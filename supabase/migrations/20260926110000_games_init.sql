-- Bob games (epic #460, unit G2): sessions, parental settings and daily
-- usage. docs/games/tool-contracts.md section 1 (State, Lifecycle) and
-- safety.md S3-S6. Follows the init migration's assembly order: 1 tables ·
-- 2 indexes · 3 enable/force RLS · 4 policies · 5 service functions ·
-- 6 grants. No vector / pg_cron / pgmq, so it applies under PGlite.
--
-- Accounts read and write only their own rows. Children's data is minimal:
-- players hold a first name or nickname and a band, nothing else, and are
-- emptied when the game ends (S3). Account erasure removes all three tables
-- through bob_private.purge_account_games (store/erasure.ts).

-- 1.1 bob.game_sessions -- one row per game; at most one non-ended game per
--     conversation. version is the optimistic lock: every write is
--     `where version = $n`, and bumps it.
create table bob.game_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  conversation_id text not null references bob.conversations (id) on delete cascade,
  device_id       uuid null references bob.devices (id) on delete set null,
  game            text not null check (game in
                  ('animal_riddles', 'simon_says', 'family_quiz', 'twenty_questions', 'silly_stories')),
  status          text not null default 'active' check (status in ('active', 'paused', 'ended')),
  seed            integer not null check (seed >= 0),
  players         jsonb not null default '[]'::jsonb check (jsonb_typeof(players) = 'array'),
  turn_index      integer not null default 0 check (turn_index >= 0),
  scores          jsonb not null default '[]'::jsonb check (jsonb_typeof(scores) = 'array'),
  state           jsonb not null default '{}'::jsonb,
  version         integer not null default 1 check (version >= 1),
  started_at      timestamptz not null default now(),
  last_turn_at    timestamptz not null default now(),
  ended_at        timestamptz null,
  end_reason      text null check (end_reason is null or end_reason in
                  ('finished', 'stopped', 'timeout', 'time_limit', 'quiet_hours')),
  check ((status = 'ended') = (ended_at is not null)),
  check ((status = 'ended') = (end_reason is not null)),
  check (status <> 'ended' or players = '[]'::jsonb)
);

-- 1.2 bob.game_settings -- one row per account (S4). No row means defaults.
--     Written only by the web settings route, never by a tool.
create table bob.game_settings (
  user_id             uuid primary key references auth.users (id) on delete cascade,
  enabled             boolean not null default true,
  kids_mode           boolean not null default true,
  max_band            text not null default 'kid' check (max_band in ('little', 'kid', 'grown')),
  allowed_games       text[] not null
                      default array['animal_riddles', 'simon_says', 'family_quiz', 'twenty_questions', 'silly_stories']
                      check (allowed_games <@ array['animal_riddles', 'simon_says', 'family_quiz',
                                                    'twenty_questions', 'silly_stories']),
  daily_limit_minutes integer not null default 45 check (daily_limit_minutes between 1 and 600),
  quiet_start         text null check (quiet_start is null or quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  quiet_end           text null check (quiet_end is null or quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  updated_at          timestamptz not null default now(),
  check ((quiet_start is null) = (quiet_end is null))
);

-- 1.3 bob.game_usage -- seconds played per account per local day (S5), the
--     day taken in the account time zone.
create table bob.game_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day     date not null,
  seconds integer not null default 0 check (seconds >= 0),
  primary key (user_id, day)
);

-- 2. Indexes -- one non-ended game per conversation, and the account's lookups.
create unique index game_sessions_one_open_per_conversation
  on bob.game_sessions (conversation_id)
  where status <> 'ended';
create index game_sessions_user_started_idx
  on bob.game_sessions (user_id, started_at desc);

-- 3. RLS
alter table bob.game_sessions enable row level security;
alter table bob.game_sessions force row level security;
alter table bob.game_settings enable row level security;
alter table bob.game_settings force row level security;
alter table bob.game_usage enable row level security;
alter table bob.game_usage force row level security;

-- 4. Policies -- own rows only.
create policy game_sessions_select on bob.game_sessions
  for select to authenticated using ((select auth.uid()) = user_id);
-- A foreign key ignores RLS, so the write checks also require the caller's own
-- conversation and device: nobody can attach a game to another account's.
create policy game_sessions_insert on bob.game_sessions
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from bob.conversations c
                 where c.id = conversation_id and c.user_id = (select auth.uid()))
    and (device_id is null or exists (select 1 from bob.devices d
                 where d.id = device_id and d.user_id = (select auth.uid())))
  );
create policy game_sessions_update on bob.game_sessions
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from bob.conversations c
                 where c.id = conversation_id and c.user_id = (select auth.uid()))
    and (device_id is null or exists (select 1 from bob.devices d
                 where d.id = device_id and d.user_id = (select auth.uid())))
  );

create policy game_settings_select on bob.game_settings
  for select to authenticated using ((select auth.uid()) = user_id);
create policy game_settings_insert on bob.game_settings
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy game_settings_update on bob.game_settings
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy game_usage_select on bob.game_usage
  for select to authenticated using ((select auth.uid()) = user_id);
create policy game_usage_insert on bob.game_usage
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy game_usage_update on bob.game_usage
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- 5. Erasure (server path only): every games row of one account, all three
--    tables, in the erase_account transaction. Returns the rows removed.
create or replace function bob_private.purge_account_games(p_user_id uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_total integer := 0;
  v_touched integer;
begin
  delete from bob.game_sessions where user_id = p_user_id;
  get diagnostics v_touched = row_count; v_total := v_total + v_touched;
  delete from bob.game_settings where user_id = p_user_id;
  get diagnostics v_touched = row_count; v_total := v_total + v_touched;
  delete from bob.game_usage where user_id = p_user_id;
  get diagnostics v_touched = row_count; v_total := v_total + v_touched;
  return v_total;
end;
$$;

-- 6. Grants (init-migration §2.7 pattern) -- nothing for anon/public.
grant select, insert, update on bob.game_sessions to authenticated;
grant select, insert, update on bob.game_settings to authenticated;
grant select, insert, update on bob.game_usage to authenticated;

revoke all on function bob_private.purge_account_games(uuid) from public, anon, authenticated;
grant execute on function bob_private.purge_account_games(uuid) to bob_server;
