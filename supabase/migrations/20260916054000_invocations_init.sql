-- Bob AI invocations (S14-T009, specs/014-family-collaboration/contracts/
-- api.md "Threads and messages"). One row per explicit ask of Bob, recording
-- the authority at dispatch (membership_revision) and the thread context
-- boundary (context_high_water) so an effect never outlives the authority that
-- requested it. Follows the spaces-init migration's assembly order: 1 tables ·
-- 2 indexes · 3 enable/force RLS · 4 policies · 5 grants. Reuses
-- bob_private.is_space_member(space_id) from 20260916050000 -- no second copy
-- of that helper. No vector / pg_cron / pgmq, so it applies under PGlite.

-- 1. Table.
create table bob.ai_invocations (
  id                   uuid primary key default gen_random_uuid(),
  space_id             uuid not null references bob.spaces (id) on delete cascade,
  thread_id            uuid not null references bob.threads (id) on delete cascade,
  actor_user_id        uuid not null references auth.users (id),
  -- The thread sequence at dispatch: context is built only up to this boundary.
  trigger_message_id   uuid not null,
  context_high_water   bigint not null,
  -- The caller's authority at dispatch; an effect that outlives a membership
  -- change is refused before its reply is committed (re-check step).
  membership_revision  integer not null,
  state                text not null
    check (state in ('queued','running','completed','failed','cancelled')),
  result_message_id    uuid null references bob.thread_messages (id),
  error_code           text null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- A retried request is one invocation, not two.
  unique (actor_user_id, trigger_message_id)
);

-- 2. Indexes. No now() in any predicate.
-- At most ONE running invocation per thread: the AI serialises, humans may keep
-- posting. This partial unique index is the backstop; the store checks first.
create unique index ai_invocations_one_running_per_thread
  on bob.ai_invocations (thread_id) where state = 'running';

-- 3. RLS -- forced; access keys on ACTIVE membership in the space.
alter table bob.ai_invocations enable row level security;
alter table bob.ai_invocations force row level security;

-- 3.1 Terminal-state housekeeping, the revocation-safe counterpart of the RLS
--     update policy. When an actor loses membership while the model is
--     generating, the row must still be marked cancelled -- but the membership
--     policy would then deny the write, leaving a `running` row that blocks the
--     thread forever. This definer updates the caller's OWN invocation
--     (actor_user_id = auth.uid()), so it survives revocation while remaining
--     unusable on another account's row. Mirrors bob_private
--     .bump_membership_revision (owner = the migration role, bypassing RLS).
create or replace function bob_private.finalize_invocation(
  p_id uuid,
  p_state text,
  p_result_message_id uuid default null,
  p_error_code text default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_row jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated';
  end if;
  if p_state not in ('completed', 'failed', 'cancelled') then
    raise exception 'invalid terminal state';
  end if;
  update bob.ai_invocations i
     set state = p_state,
         result_message_id = p_result_message_id,
         error_code = p_error_code,
         updated_at = now()
   where i.id = p_id
     and i.actor_user_id = (select auth.uid())
   returning to_jsonb(i) into v_row;
  return v_row;
end;
$$;

-- 4. Policies. Every row keys on bob_private.is_space_member(space_id).
create policy ai_invocations_select on bob.ai_invocations
  for select to authenticated
  using (bob_private.is_space_member(ai_invocations.space_id));

create policy ai_invocations_insert on bob.ai_invocations
  for insert to authenticated
  with check (bob_private.is_space_member(ai_invocations.space_id));

create policy ai_invocations_update on bob.ai_invocations
  for update to authenticated
  using (bob_private.is_space_member(ai_invocations.space_id))
  with check (bob_private.is_space_member(ai_invocations.space_id));

create policy ai_invocations_delete on bob.ai_invocations
  for delete to authenticated
  using (bob_private.is_space_member(ai_invocations.space_id));

-- 5. Grants (init-migration §2.7 pattern). Cancellation authorship (only the
--    requesting actor may cancel their own) is enforced in the store's WHERE,
--    as with thread messages.
grant select, insert, update, delete on bob.ai_invocations to authenticated;

-- finalize_invocation is called from the store's terminal-state writes, which
-- run as authenticated; never exposed to anon.
revoke all on function bob_private.finalize_invocation(uuid, text, uuid, text) from public, anon;
grant execute on function bob_private.finalize_invocation(uuid, text, uuid, text) to authenticated;