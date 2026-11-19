-- Apps have an independent lifecycle; receipts are bounded metadata, not copied app state.
create table bob.bob_apps (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 lifecycle text not null default 'draft' check (lifecycle in ('draft','active','archived')),
 revision integer not null default 1 check (revision > 0),
 definition jsonb not null check (octet_length(definition::text) <= 200000),
 state jsonb not null default '{}' check (octet_length(state::text) <= 1100000),
 pending_definition jsonb check (octet_length(pending_definition::text) <= 200000),
 undo_definition jsonb check (octet_length(undo_definition::text) <= 200000),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index bob_apps_owner on bob.bob_apps(user_id,updated_at desc);
alter table bob.bob_apps enable row level security;
alter table bob.bob_apps force row level security;
create policy bob_apps_owner on bob.bob_apps for all to authenticated using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
grant select,insert,update,delete on bob.bob_apps to authenticated;
create table bob.bob_app_mutations (
 user_id uuid not null references auth.users(id) on delete cascade,
 mutation_id uuid not null, fingerprint text not null,
 app_id uuid, created_at timestamptz not null default now(),
 primary key(user_id,mutation_id)
);
alter table bob.bob_app_mutations enable row level security;
alter table bob.bob_app_mutations force row level security;
create policy bob_app_mutations_owner on bob.bob_app_mutations for all to authenticated using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
grant select,insert,delete on bob.bob_app_mutations to authenticated;
create function bob_private.purge_bob_apps(owner_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
 delete from bob.bob_apps where user_id=owner_id;
 delete from bob.bob_app_mutations where user_id=owner_id;
end;
$$;
revoke all on function bob_private.purge_bob_apps(uuid) from public,anon,authenticated;
grant execute on function bob_private.purge_bob_apps(uuid) to bob_server;
