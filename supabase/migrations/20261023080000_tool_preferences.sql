create table bob.tool_preferences (
  scope text not null check (scope in ('account','integration','space','conversation')),
  scope_id text not null,
  tool_id text not null check (length(tool_id) between 1 and 80),
  enabled boolean not null,
  owner_user_id uuid references auth.users(id) on delete cascade,
  integration_id uuid references bob.google_accounts(id) on delete cascade,
  space_id uuid references bob.spaces(id) on delete cascade,
  conversation_id text references bob.conversations(id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key(scope,scope_id,tool_id),
  check (
    (scope='account' and owner_user_id is not null and scope_id=owner_user_id::text and integration_id is null and space_id is null and conversation_id is null) or
    (scope='integration' and integration_id is not null and scope_id=integration_id::text and owner_user_id is not null and space_id is null and conversation_id is null) or
    (scope='space' and space_id is not null and scope_id=space_id::text and owner_user_id is null and integration_id is null and conversation_id is null) or
    (scope='conversation' and conversation_id is not null and scope_id=conversation_id and owner_user_id is null and integration_id is null and space_id is null)
  )
);
alter table bob.tool_preferences enable row level security;
alter table bob.tool_preferences force row level security;
create policy tool_preferences_read on bob.tool_preferences for select to authenticated using (
  (scope='account' and owner_user_id=(select auth.uid())) or
  (scope='integration' and owner_user_id=(select auth.uid()) and exists(select 1 from bob.google_accounts g where g.id=integration_id and g.user_id=(select auth.uid()))) or
  (scope='space' and exists(select 1 from bob.spaces s where s.id=space_id and s.archived_at is null and bob_private.is_space_member(s.id))) or
  (scope='conversation' and exists(select 1 from bob.conversations c join bob.spaces s on s.id=c.space_id where c.id=conversation_id and c.archived_at is null and s.archived_at is null and bob_private.is_space_member(s.id)))
);
create policy tool_preferences_write on bob.tool_preferences for all to authenticated using (
  (scope='account' and owner_user_id=(select auth.uid())) or
  (scope='integration' and owner_user_id=(select auth.uid()) and exists(select 1 from bob.google_accounts g where g.id=integration_id and g.user_id=(select auth.uid()))) or
  (scope='space' and exists(select 1 from bob.spaces s where s.id=space_id and s.archived_at is null and bob_private.is_space_owner_or_admin(s.id))) or
  (scope='conversation' and exists(select 1 from bob.conversations c join bob.spaces s on s.id=c.space_id where c.id=conversation_id and c.archived_at is null and s.archived_at is null and bob_private.is_space_member(s.id) and (c.user_id=(select auth.uid()) or bob_private.is_space_owner_or_admin(s.id))))
) with check (
  (scope='account' and owner_user_id=(select auth.uid())) or
  (scope='integration' and owner_user_id=(select auth.uid()) and exists(select 1 from bob.google_accounts g where g.id=integration_id and g.user_id=(select auth.uid()))) or
  (scope='space' and exists(select 1 from bob.spaces s where s.id=space_id and s.archived_at is null and bob_private.is_space_owner_or_admin(s.id))) or
  (scope='conversation' and exists(select 1 from bob.conversations c join bob.spaces s on s.id=c.space_id where c.id=conversation_id and c.archived_at is null and s.archived_at is null and bob_private.is_space_member(s.id) and (c.user_id=(select auth.uid()) or bob_private.is_space_owner_or_admin(s.id))))
);
grant select,insert,update,delete on bob.tool_preferences to authenticated;
