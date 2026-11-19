-- Marketing configuration proposals and versions (U4). Config is separate from the installation revision and from
-- campaign data: it only changes which views, grouping and default channels the workspace uses. Every row is
-- owner-scoped with forced RLS. Installation-owned rows cascade through the composite owner+installation FK.

-- Proposal: a server-generated, hash-bound request to replace the whole config. Nothing here is applied until the
-- owner's apply call checks the hash, the base config revision and the live configure grant under the owner lock.
create table bob.marketing_config_proposals (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 installation_id uuid not null,
 base_config_revision integer not null check (base_config_revision > 0),
 package_version text not null check (length(package_version) between 1 and 20),
 proposed_config jsonb not null check (jsonb_typeof(proposed_config) = 'object' and octet_length(proposed_config::text) <= 2000),
 canonical_hash text not null check (length(canonical_hash) = 64),
 required_capabilities text[] not null default '{}' check (required_capabilities <@ array['campaign.configure']::text[]),
 preview_receipt jsonb not null check (jsonb_typeof(preview_receipt) = 'object' and octet_length(preview_receipt::text) <= 8000),
 status text not null default 'pending' check (status in ('pending','applied','discarded')),
 created_at timestamptz not null default now(),
 unique (user_id,id),
 foreign key (user_id,installation_id) references bob.bob_app_installations(user_id,id) on delete cascade
);
alter table bob.marketing_config_proposals enable row level security;
alter table bob.marketing_config_proposals force row level security;
create policy marketing_config_proposals_owner on bob.marketing_config_proposals for all to authenticated
 using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
grant select,insert,update,delete on bob.marketing_config_proposals to authenticated;

-- Version: the config that was live at a revision. The current revision is always kept; older revisions are pruned
-- by the service (100 past revisions). A proposal's deletion keeps the version and clears its source reference.
create table bob.marketing_config_versions (
 user_id uuid not null references auth.users(id) on delete cascade,
 installation_id uuid not null,
 revision integer not null check (revision > 0),
 config jsonb not null check (jsonb_typeof(config) = 'object' and octet_length(config::text) <= 2000),
 package_version text not null check (length(package_version) between 1 and 20),
 source_proposal_id uuid,
 created_at timestamptz not null default now(),
 primary key (installation_id,revision),
 foreign key (user_id,installation_id) references bob.bob_app_installations(user_id,id) on delete cascade,
 foreign key (user_id,source_proposal_id) references bob.marketing_config_proposals(user_id,id) on delete set null (source_proposal_id)
);
alter table bob.marketing_config_versions enable row level security;
alter table bob.marketing_config_versions force row level security;
create policy marketing_config_versions_owner on bob.marketing_config_versions for all to authenticated
 using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
grant select,insert,delete on bob.marketing_config_versions to authenticated;

-- Operation receipts: one per owner mutation key. The minimal receipt contains only opaque identity, revision and status.
-- Exact proposal responses need a separate bounded enum-only snapshot after proposal retention expires; no free text
-- intent, messages or transcripts are stored. Both cascade on installation deletion. Keys are never pruned.
-- Bounded to 10000 per installation by the service; a full table refuses new edits with an explicit limit.
create table bob.marketing_config_operations (
 user_id uuid not null references auth.users(id) on delete cascade,
 installation_id uuid not null,
 mutation_id uuid not null,
 fingerprint text not null check (length(fingerprint) = 64),
 receipt jsonb not null check (jsonb_typeof(receipt) = 'object' and octet_length(receipt::text) <= 1000),
 proposal_snapshot jsonb check (proposal_snapshot is null or (jsonb_typeof(proposal_snapshot) = 'object' and octet_length(proposal_snapshot::text) <= 8000)),
 created_at timestamptz not null default now(),
 primary key (user_id,mutation_id),
 foreign key (user_id,installation_id) references bob.bob_app_installations(user_id,id) on delete cascade
);
create index marketing_config_operations_installation_idx on bob.marketing_config_operations(user_id,installation_id);
alter table bob.marketing_config_operations enable row level security;
alter table bob.marketing_config_operations force row level security;
create policy marketing_config_operations_owner on bob.marketing_config_operations for all to authenticated
 using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
grant select,insert on bob.marketing_config_operations to authenticated;

-- Erasure: the auth row stays, so cascades never fire. These rows are owner-keyed and are removed explicitly, in the
-- same order as the U2 purge (config first, then installations). Every other step is identical to the U2 definition.
create or replace function bob_private.purge_bob_apps(owner_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
 delete from bob.marketing_config_operations where user_id=owner_id;
 delete from bob.marketing_config_versions where user_id=owner_id;
 delete from bob.marketing_config_proposals where user_id=owner_id;
 delete from bob.bob_app_selection where user_id=owner_id;
 delete from bob.bob_app_marketing_operations where user_id=owner_id;
 delete from bob.bob_app_installations where user_id=owner_id;
 delete from bob.bob_apps where user_id=owner_id;
 delete from bob.bob_app_mutations where user_id=owner_id;
 -- Keep global sessions available for account-deletion retries. Marketing install/selection admission needs a newer sign-in;
 -- other APIs keep their existing valid-session semantics, including after an authorized fresh installation.
 -- App metadata is server-owned; preserve unrelated keys and read this fence from the database, never a stale JWT.
 update auth.users set raw_app_meta_data=jsonb_set(coalesce(raw_app_meta_data,'{}'::jsonb),
   '{bob_marketing_erased_before}',to_jsonb(extract(epoch from clock_timestamp())),true) where id=owner_id;
end;
$$;
revoke all on function bob_private.purge_bob_apps(uuid) from public,anon,authenticated;
grant execute on function bob_private.purge_bob_apps(uuid) to bob_server;
