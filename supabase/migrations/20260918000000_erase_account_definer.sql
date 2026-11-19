-- Account erasure, moved server-side (S14-PG-ERASURE). Erasure is inherently
-- cross-user and privileged (it rewrites other people's authorship, revokes
-- memberships, touches auth.users), so it follows the established pattern for
-- every privileged, cross-user operation in this repo (outbox_init.sql,
-- invitations_init.sql, auth_user_token_defaults.sql): a SECURITY DEFINER
-- function in bob_private, EXECUTE granted to bob_server only.
--
-- Why this had to move here rather than run on a bare tx as bob_server
-- (apps/api/src/core/erasure.ts, pre-fix):
--   1. The sole-owner refusal guard counted rows through a bare tx. Under
--      FORCE RLS, bob_server (nobypassrls) sees zero rows there, so the
--      guard could never fire -- it would have erased the sole owner of a
--      group and orphaned it. Running the count inside a SECURITY DEFINER
--      function (owned by the migration owner, who bypasses the lock, exactly
--      as outbox_init.sql's functions do) makes the guard see the real rows.
--   2. `INSERT INTO auth.users` as bob_server is refused outright
--      ("permission denied for schema auth"); only a definer may write there.
--
-- The refusal is a custom SQLSTATE ('OX001', chosen to avoid any standard
-- class) carrying the owned-group count in DETAIL, so the TS layer can
-- recognise it without parsing the message and turn it back into
-- EraseRefusedError (apps/api/src/core/erasure.ts).
--
-- The sentinel row insert is GoTrue-safe (every column GoTrue's admin API
-- scans into a non-nullable Go string is set to '', never left NULL) --
-- reproduced from 20260917010000_auth_user_token_defaults.sql, which fixed the
-- exact same class of bug for ensure_test_session.
--
-- Idempotent: a second call finds the guard already satisfied (no rows still
-- point at the erased user, no membership still active, no private space
-- still owned, no outbox row still undelivered for the actor) and returns all
-- zeros. create or replace, so this migration is re-runnable.

create or replace function bob_private.erase_account(p_user_id uuid, p_now timestamptz)
returns table (
  anonymized int,
  "assignmentsCleared" int,
  "privateSpacesDeleted" int,
  "membershipsRevoked" int,
  "jobsInvalidated" int
)
language plpgsql security definer set search_path = ''
as $$
declare
  v_owned int;
  v_anonymized int := 0;
  v_assignments_cleared int := 0;
  v_private_spaces_deleted int := 0;
  v_memberships_revoked int := 0;
  v_jobs_invalidated int := 0;
  v_touched int;
begin
  -- Guard (criterion 3): an account that still SOLELY owns a group must
  -- transfer or delete it first, or the household would be orphaned. Counts
  -- ONLY -- never a group name, so a refusal cannot leak what the caller can
  -- no longer see.
  select count(*)::int into v_owned
    from bob.spaces s
   where s.kind = 'group'
     and s.owner_user_id = p_user_id
     and not exists (
       select 1 from bob.space_memberships m
        where m.space_id = s.id
          and m.user_id <> p_user_id
          and m.role = 'owner'
          and m.revoked_at is null
     );
  if v_owned > 0 then
    raise exception 'bob: account still owns % group(s); transfer or delete before erasing', v_owned
      using errcode = 'OX001', detail = v_owned::text;
  end if;

  -- Ensure the sentinel row authorship gets repointed to exists. Mirrors
  -- ensure_test_session's GoTrue-safe insert exactly: every scanned token
  -- column '' rather than NULL, or GET /auth/v1/admin/users breaks
  -- project-wide. Keep '00000000-0000-4000-8000-0000000000de' in sync with
  -- ERASED_USER_ID in apps/api/src/core/erasure.ts.
  insert into auth.users (
    id, email, aud, role, confirmation_token, recovery_token, email_change,
    email_change_token_new, email_change_token_current, phone_change,
    phone_change_token, reauthentication_token
  )
  values (
    '00000000-0000-4000-8000-0000000000de', 'erased@bob.local',
    'authenticated', 'authenticated', '', '', '', '', '', '', '', ''
  )
  on conflict (id) do nothing;

  -- Anonymize authorship: the work others rely on stays, attribution moves to
  -- the sentinel. Same eight columns, same order, as the pre-fix TS code.
  update bob.tasks set created_by = '00000000-0000-4000-8000-0000000000de'
   where created_by = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.tasks set completed_by = '00000000-0000-4000-8000-0000000000de'
   where completed_by = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.threads set created_by = '00000000-0000-4000-8000-0000000000de'
   where created_by = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.thread_messages set author_user_id = '00000000-0000-4000-8000-0000000000de'
   where author_user_id = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.thread_messages set tombstoned_by = '00000000-0000-4000-8000-0000000000de'
   where tombstoned_by = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.notes set created_by = '00000000-0000-4000-8000-0000000000de'
   where created_by = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.notes set updated_by = '00000000-0000-4000-8000-0000000000de'
   where updated_by = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.note_revisions set editor_user_id = '00000000-0000-4000-8000-0000000000de'
   where editor_user_id = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  -- Clear the erased account's trace on other people's task lists.
  update bob.tasks set assignee_user_id = null where assignee_user_id = p_user_id;
  get diagnostics v_touched = row_count; v_assignments_cleared := v_assignments_cleared + v_touched;

  delete from bob.task_subscribers where user_id = p_user_id;
  get diagnostics v_touched = row_count; v_assignments_cleared := v_assignments_cleared + v_touched;

  delete from bob.thread_reads where user_id = p_user_id;
  get diagnostics v_touched = row_count; v_assignments_cleared := v_assignments_cleared + v_touched;

  -- Delete the account's private spaces (and, by cascade, the resources
  -- inside them). A space with any other member is not private content.
  delete from bob.spaces where kind = 'private' and owner_user_id = p_user_id;
  get diagnostics v_touched = row_count; v_private_spaces_deleted := v_touched;

  -- Revoke memberships (history preserved, not deleted).
  update bob.space_memberships
     set revoked_at = p_now
   where user_id = p_user_id and revoked_at is null;
  get diagnostics v_touched = row_count; v_memberships_revoked := v_touched;

  -- Invalidate the erased actor's undelivered outbox work so the drain worker
  -- never acts on their behalf after erasure: mark delivered (skip), clear any
  -- lease. Scoped to the actor via the payload allowlist column
  -- (outbox_init.sql); every other actor's row is left untouched. Unleased
  -- only (a row another worker is actively delivering right now is left to
  -- that worker). Deliberately NOT gated on available_at <= p_now: a
  -- future-scheduled retry for an actor who no longer exists should also
  -- never fire, and gating on the caller's clock against the DB server's
  -- clock is needless skew risk for no behavioural benefit.
  update bob.outbox
     set delivered_at = p_now, lease_owner = null, lease_expires_at = null
   where delivered_at is null
     and lease_owner is null
     and lease_expires_at is null
     and payload ->> 'actor_user_id' = p_user_id::text;
  get diagnostics v_touched = row_count; v_jobs_invalidated := v_touched;

  return query
    select v_anonymized, v_assignments_cleared, v_private_spaces_deleted,
           v_memberships_revoked, v_jobs_invalidated;
end;
$$;

-- EXECUTE to bob_server only. An ordinary signed-in user must NOT be able to
-- erase anyone, including by calling the function directly.
revoke all on function bob_private.erase_account(uuid, timestamptz) from public, anon, authenticated;
grant execute on function bob_private.erase_account(uuid, timestamptz) to bob_server;
