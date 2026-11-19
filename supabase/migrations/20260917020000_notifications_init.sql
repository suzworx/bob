-- Bob durable inbox and per-type controls (S14-INBOX-STORE, specs/014-family-
-- collaboration/data-model.md "notifications", "notification_preferences";
-- contracts/api.md "Notifications"). The inbox stores ids, types and revisions
-- ONLY -- never a title, body or snippet -- so the client refetches each
-- resource under its own authorization. Follows the spaces-init assembly order:
-- 1 tables (dependency order) · 2 indexes · 3 enable/force RLS · 4 policies
-- · 5 server write path · 6 grants. No vector / pg_cron / pgmq, so it applies
-- under PGlite.
--
-- Why revocation lives in the SELECT policy: when a member loses access to a
-- space, refetching the inbox must show none of its items and leak no title or
-- snippet (issue #127, acceptance criterion 3). That is a policy, not a filter
-- in application code, so the one select policy re-checks ACTIVE membership in
-- the notification's space through bob_private.is_space_member -- a removed
-- member's rows disappear from every read with no application code running.
-- Security notices (type 'security', space_id null) survive any space removal
-- because the policy passes when space_id is null.

-- 1. Tables in dependency order: notifications -> notification_preferences.

-- 1.1 bob.notifications (data-model.md "notifications"). The recipient key +
--     effect_key unique pair is what makes a replayed outbox row safe: one
--     recipient can never receive the same effect twice. cursor is the
--     monotonic durable cursor the client reads back.
create table bob.notifications (
  id                uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references auth.users (id) on delete cascade,
  space_id          uuid null references bob.spaces (id) on delete cascade,
  type              text not null
                    check (type in ('mention', 'assignment', 'reminder',
                                    'event_change', 'invitation', 'security')),
  resource_type     text not null check (char_length(resource_type) between 1 and 32),
  resource_id       uuid not null,
  revision          integer not null default 1,
  effect_key        text not null,
  cursor            bigserial not null unique,
  read_at           timestamptz null,
  created_at        timestamptz not null default now(),
  unique (recipient_user_id, effect_key)
);

-- 1.2 bob.notification_preferences (data-model.md "notification_preferences").
--     type null = all types. Quiet hours are all-or-nothing: start, end and
--     zone are set together or not at all.
create table bob.notification_preferences (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  space_id          uuid null references bob.spaces (id) on delete cascade,
  thread_id         uuid null references bob.threads (id) on delete cascade,
  type              text null
                    check (type is null or type in ('mention', 'assignment',
                                                    'reminder', 'event_change',
                                                    'invitation', 'security')),
  muted             boolean not null default false,
  quiet_hours_start time null,
  quiet_hours_end   time null,
  quiet_zone        text null,
  check (
    (quiet_hours_start is null and quiet_hours_end is null and quiet_zone is null) or
    (quiet_hours_start is not null and quiet_hours_end is not null and quiet_zone is not null)
  )
);

-- 2. Indexes.
-- The feed: newest first for one recipient (data-model.md "notifications" --
-- "monotonic durable cursor").
create index notifications_feed_idx
  on bob.notifications (recipient_user_id, cursor desc);
-- Unread scans (unreadCount) touch only rows still to read.
create index notifications_unread_idx
  on bob.notifications (recipient_user_id, cursor desc) where read_at is null;

-- The preferences key. NULLs are a real key here: (user_id, space=null,
-- thread=null, type=null) is the GLOBAL row, distinct from any scoped row. A
-- plain UNIQUE constraint would treat NULLs as distinct and allow duplicate
-- global rows, so the unique index is over coalesced values -- and
-- upsertPreference's ON CONFLICT target uses the exact same expressions, so a
-- preference is upserted, never duplicated.
create unique index notification_prefs_key_uidx
  on bob.notification_preferences (
    user_id,
    coalesce(space_id, '00000000-0000-0000-0000-000000000000'),
    coalesce(thread_id, '00000000-0000-0000-0000-000000000000'),
    coalesce(type, '')
  );

-- 3. RLS -- both tables force it. Access is decided by the recipient's own uid
--    plus (for notifications) an ACTIVE membership in the row's space.
alter table bob.notifications enable row level security;
alter table bob.notifications force row level security;
alter table bob.notification_preferences enable row level security;
alter table bob.notification_preferences force row level security;

-- 4. Policies.
-- 4.1 bob.notifications. The crux (issue #127): a notification exists for a
--     reader exactly when they are its recipient AND still an ACTIVE member of
--     its space (or it has no space -- a security notice). A removed member's
--     rows vanish from every read with no application code running, and there
--     are no title/body/snippet columns to leak. is_space_member is the
--     recursion-breaking definer from spaces-init, so this policy does not
--     recurse through space_memberships.
create policy notifications_select on bob.notifications
  for select to authenticated
  using (
    recipient_user_id = (select auth.uid())
    and (space_id is null or bob_private.is_space_member(space_id))
  );

-- The only update an account may make: move read_at on their OWN rows. The
-- column grant below limits the writeable column to read_at; the WITH CHECK
-- keeps the recipient fixed. There is deliberately NO insert policy --
-- notifications are written only by the server role via the definer function
-- in section 5.
create policy notifications_update on bob.notifications
  for update to authenticated
  using (recipient_user_id = (select auth.uid()))
  with check (recipient_user_id = (select auth.uid()));

-- 4.2 bob.notification_preferences. A person owns their own preferences:
--     every statement is scoped to their uid.
create policy notification_preferences_select on bob.notification_preferences
  for select to authenticated using (user_id = (select auth.uid()));
create policy notification_preferences_insert on bob.notification_preferences
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy notification_preferences_update on bob.notification_preferences
  for update to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy notification_preferences_delete on bob.notification_preferences
  for delete to authenticated using (user_id = (select auth.uid()));

-- 5. Server write path (the outbox pattern, option A). FORCE RLS with no insert
--    policy locks out every account role AND bob_server (nobypassrls,
--    init-migration §2.7), so the fanout worker inserts through this SECURITY
--    DEFINER function, which runs as the migration owner and bypasses the lock.
--    Batched via unnest and idempotent on (recipient_user_id, effect_key): a
--    replayed outbox row resolves to the existing notification, never a
--    duplicate. The store shares its caller's transaction (no BEGIN here), so
--    an outbox row and its notifications commit together.
create or replace function bob_private.notifications_enqueue(
  p_recipient_user_ids uuid[], p_space_ids uuid[], p_types text[],
  p_resource_types text[], p_resource_ids uuid[], p_revisions int[], p_effect_keys text[]
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into bob.notifications
    (recipient_user_id, space_id, type, resource_type, resource_id, revision, effect_key)
  select u.recipient_user_id, u.space_id, u.type, u.resource_type, u.resource_id,
         u.revision, u.effect_key
    from unnest(p_recipient_user_ids, p_space_ids, p_types, p_resource_types,
                p_resource_ids, p_revisions, p_effect_keys)
         as u(recipient_user_id, space_id, type, resource_type, resource_id, revision, effect_key)
  on conflict (recipient_user_id, effect_key) do nothing;
end;
$$;

-- 6. Grants (init-migration §2.7 pattern). Accounts read and mark-read their
--    own notifications; read_at is the ONLY updateable column for an account.
--    Preferences are fully owned by the account. The server role writes
--    notifications only through the definer above (EXECUTE to bob_server
--    alone; nothing for public/anon/authenticated), never through a table
--    grant, so no account path can insert a row for someone else.
grant select on bob.notifications to authenticated;
grant update (read_at) on bob.notifications to authenticated;
grant select, insert, update, delete on bob.notification_preferences to authenticated;
revoke all on function bob_private.notifications_enqueue(uuid[], uuid[], text[], text[], uuid[], integer[], text[]) from public, anon, authenticated;
grant execute on function bob_private.notifications_enqueue(uuid[], uuid[], text[], text[], uuid[], integer[], text[]) to bob_server;