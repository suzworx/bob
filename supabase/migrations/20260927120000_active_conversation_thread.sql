-- Bob device pointer can name a space thread (issue #565, unit U1, plan D1).
-- Additive: two nullable columns on bob.active_conversations naming a thread
-- and its space, kept in step with bob.threads by a composite FK onto its
-- unique (id, space_id). No new table, no triggers.
--
-- Rollback rule: the old server's setActive upsert writes only
-- conversation_id / changed_at / surface. When conversation_id is set it wins;
-- the thread counts only while conversation_id is null. The new server always
-- writes both sides explicitly (one side null). An old server reading a
-- thread pointer sees conversation_id null and treats it as cleared (safe).
--
-- The policies only prove the caller may name the thread's space (an ACTIVE
-- membership, via bob_private.is_space_member, as active_spaces does). An
-- archived thread, or one whose membership was revoked later, is cleared by
-- the store on the next read (store/active-conversation.ts getActive).
-- No vector / pg_cron / pgmq, so it applies under PGlite.

-- 1. Columns. Both null, or both set.
alter table bob.active_conversations
  add column if not exists thread_id uuid null,
  add column if not exists thread_space_id uuid null;

alter table bob.active_conversations
  add constraint active_conversations_thread_fk
    foreign key (thread_id, thread_space_id)
    references bob.threads (id, space_id) on delete set null;

alter table bob.active_conversations
  add constraint active_conversations_thread_pair
    check ((thread_id is null) = (thread_space_id is null));

-- 2. Indexes -- the FK's on-delete-set-null lookup and the per-space clear.
create index if not exists active_conversations_thread_idx
  on bob.active_conversations (thread_id);
create index if not exists active_conversations_thread_space_idx
  on bob.active_conversations (thread_space_id);

-- 3. Policies. Recreated with the space-membership check added; the select
--    policy and the grants are unchanged.
drop policy if exists active_conversations_insert on bob.active_conversations;
create policy active_conversations_insert on bob.active_conversations
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (thread_space_id is null or bob_private.is_space_member(thread_space_id))
  );
drop policy if exists active_conversations_update on bob.active_conversations;
create policy active_conversations_update on bob.active_conversations
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and (thread_space_id is null or bob_private.is_space_member(thread_space_id))
  );
