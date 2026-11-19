-- Ask Bob proposals (v4 screen 13, story #1191): Bob proposes steps, the owner
-- approves or declines, and an audit trail records the outcome. Additive only.
--
-- heybob.xyzroval_proposals holds what a proposal needs to run (steps carry their
-- params, which are never sent back to the client). heybob.xyzroval_audit holds
-- the action type, the time and the outcome and NOTHING else: no title, no
-- subline, no params, no message body. Both are owner-only under FORCE RLS.

create table heybob.xyzroval_proposals (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  title      text not null check (char_length(title) between 1 and 120),
  status     text not null default 'pending'
             check (status in ('pending', 'approved', 'declined', 'failed')),
  steps      jsonb not null
             check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 8),
  changes    jsonb not null default '[]'::jsonb
             check (jsonb_typeof(changes) = 'array' and jsonb_array_length(changes) <= 8),
  notify     jsonb not null default '[]'::jsonb
             check (jsonb_typeof(notify) = 'array' and jsonb_array_length(notify) <= 10),
  reminder   jsonb null check (reminder is null or jsonb_typeof(reminder) = 'object'),
  created_at timestamptz not null default now(),
  decided_at timestamptz null,
  check ((status = 'pending') = (decided_at is null))
);

create index approval_proposals_user_created_idx
  on heybob.xyzroval_proposals (user_id, created_at desc);

create table heybob.xyzroval_audit (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  proposal_id uuid not null references heybob.xyzroval_proposals (id) on delete cascade,
  action      text not null check (char_length(action) between 1 and 40),
  outcome     text not null check (outcome in ('succeeded', 'failed', 'approved', 'declined')),
  created_at  timestamptz not null default now()
);

create index approval_audit_proposal_idx on heybob.xyzroval_audit (proposal_id, created_at);

alter table heybob.xyzroval_proposals enable row level security;
alter table heybob.xyzroval_proposals force row level security;
alter table heybob.xyzroval_audit enable row level security;
alter table heybob.xyzroval_audit force row level security;

-- Owner-only. Delete is for account erasure (the audit rows go with their proposal by cascade).
-- A proposal is decided once: the store claims it with
-- UPDATE ... WHERE status = 'pending', and only status and decided_at may change.
create policy approval_proposals_select on heybob.xyzroval_proposals
  for select to authenticated using (user_id = (select auth.uid()));
create policy approval_proposals_insert on heybob.xyzroval_proposals
  for insert to authenticated with check (user_id = (select auth.uid()) and status = 'pending');
create policy approval_proposals_update on heybob.xyzroval_proposals
  for update to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy approval_proposals_delete on heybob.xyzroval_proposals
  for delete to authenticated using (user_id = (select auth.uid()));

create policy approval_audit_select on heybob.xyzroval_audit
  for select to authenticated using (user_id = (select auth.uid()));
create policy approval_audit_insert on heybob.xyzroval_audit
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from heybob.xyzroval_proposals p
      where p.id = proposal_id and p.user_id = (select auth.uid())
    )
  );

grant select, insert, delete on heybob.xyzroval_proposals to authenticated;
grant update (status, decided_at) on heybob.xyzroval_proposals to authenticated;
grant select, insert on heybob.xyzroval_audit to authenticated;
