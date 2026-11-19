-- Marketing campaigns (U3): authoritative private rows under an installed Marketing app. The generic app state
-- (bob_apps.state, records, undo and copy) never reads or writes these tables. Every table is owner-scoped by RLS and
-- cascades from its installation, so installation deletion and account erasure remove campaigns, drafts, selections
-- and receipts together.
alter table bob.conversations add constraint conversations_owner_id_key unique (user_id,id);

create table bob.bob_app_campaigns (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 installation_id uuid not null,
 name text not null check (length(btrim(name)) between 1 and 80),
 goal text not null check (goal in ('awareness','curiosity','beta_interest')),
 goal_note text check (goal_note is null or octet_length(goal_note) <= 500),
 channels text[] not null check (cardinality(channels) between 1 and 2 and channels <@ array['instagram','linkedin']::text[]
  and (cardinality(channels) = 1 or channels[1] <> channels[2])),
 status text not null default 'draft' check (status in ('draft','paused','archived')),
 revision integer not null default 1 check (revision > 0),
 pack_revision text not null check (length(pack_revision) = 64),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (user_id,installation_id,id),
 foreign key (user_id,installation_id) references bob.bob_app_installations(user_id,id) on delete cascade
);

-- One row per section that has text. Absence means an empty section. The campaign revision guards every write.
create table bob.bob_app_campaign_sections (
 user_id uuid not null references auth.users(id) on delete cascade,
 installation_id uuid not null,
 campaign_id uuid not null,
 section text not null check (section in ('brief','strategy','positioning','calendar','measurement','review')),
 content text not null default '' check (octet_length(content) <= 20000),
 updated_at timestamptz not null default now(),
 primary key (campaign_id,section),
 foreign key (user_id,installation_id,campaign_id) references bob.bob_app_campaigns(user_id,installation_id,id) on delete cascade
);

-- Drafts reference only known pack IDs (checked by the service). Reference validity is not semantic accuracy: a
-- draft stays needs_check until a reviewed check says otherwise. Instagram posts are image or carousel only.
create table bob.bob_app_campaign_drafts (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 installation_id uuid not null,
 campaign_id uuid not null,
 channel text not null check (channel in ('instagram','linkedin')),
 format text not null check (format in ('text','image','carousel')),
 check (channel = 'linkedin' or format in ('image','carousel')),
 body text not null default '' check (octet_length(body) <= 8000),
 alt_text text check (alt_text is null or octet_length(alt_text) <= 2000),
 pillar text check (pillar is null or octet_length(pillar) <= 120),
 approved_asset_ids text[] not null default '{}' check (cardinality(approved_asset_ids) <= 8),
 claim_ids text[] not null default '{}' check (cardinality(claim_ids) <= 20),
 cta text not null default 'none' check (cta in ('none','waitlist','signin')),
 state text not null default 'needs_check' check (state in ('draft','needs_check')),
 content_revision integer not null default 1 check (content_revision > 0),
 pack_revision text not null check (length(pack_revision) = 64),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key (user_id,installation_id,campaign_id) references bob.bob_app_campaigns(user_id,installation_id,id) on delete cascade
);
create index bob_app_campaign_drafts_campaign_idx on bob.bob_app_campaign_drafts (user_id,campaign_id,id);

-- The active campaign for one owner, installation and conversation. Only the conversation's own owner can point at it.
create table bob.bob_app_campaign_selection (
 user_id uuid not null references auth.users(id) on delete cascade,
 installation_id uuid not null,
 conversation_id text not null,
 campaign_id uuid not null,
 selected_at timestamptz not null default now(),
 primary key (user_id,installation_id,conversation_id),
 foreign key (user_id,conversation_id) references bob.conversations(user_id,id) on delete cascade,
 foreign key (user_id,installation_id) references bob.bob_app_installations(user_id,id) on delete cascade,
 foreign key (user_id,installation_id,campaign_id) references bob.bob_app_campaigns(user_id,installation_id,id) on delete cascade
);

-- Durable operation receipts. The key is a UI UUID or a server-derived SHA256 for a tool call, and it is never pruned:
-- the service refuses new writes at the installation cap while exact replays keep working. The receipt is minimal.
create table bob.bob_app_campaign_operations (
 user_id uuid not null references auth.users(id) on delete cascade,
 installation_id uuid not null,
 operation_key text not null check (length(operation_key) between 36 and 64),
 canonical_hash text not null check (length(canonical_hash) = 64),
 receipt jsonb not null check (jsonb_typeof(receipt) = 'object' and octet_length(receipt::text) <= 1000),
 created_at timestamptz not null default now(),
 primary key (user_id,installation_id,operation_key),
 foreign key (user_id,installation_id) references bob.bob_app_installations(user_id,id) on delete cascade
);

alter table bob.bob_app_campaigns enable row level security;
alter table bob.bob_app_campaign_sections enable row level security;
alter table bob.bob_app_campaign_drafts enable row level security;
alter table bob.bob_app_campaign_selection enable row level security;
alter table bob.bob_app_campaign_operations enable row level security;
alter table bob.bob_app_campaigns force row level security;
alter table bob.bob_app_campaign_sections force row level security;
alter table bob.bob_app_campaign_drafts force row level security;
alter table bob.bob_app_campaign_selection force row level security;
alter table bob.bob_app_campaign_operations force row level security;

create policy bob_app_campaigns_owner on bob.bob_app_campaigns for all to authenticated
 using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
create policy bob_app_campaign_sections_owner on bob.bob_app_campaign_sections for all to authenticated
 using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
create policy bob_app_campaign_drafts_owner on bob.bob_app_campaign_drafts for all to authenticated
 using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
create policy bob_app_campaign_selection_owner on bob.bob_app_campaign_selection for all to authenticated
 using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
create policy bob_app_campaign_operations_owner on bob.bob_app_campaign_operations for all to authenticated
 using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));

grant select,insert,update on bob.bob_app_campaigns to authenticated;
grant select,insert,update on bob.bob_app_campaign_sections to authenticated;
grant select,insert,update on bob.bob_app_campaign_drafts to authenticated;
grant select,insert,update,delete on bob.bob_app_campaign_selection to authenticated;
grant select,insert on bob.bob_app_campaign_operations to authenticated;
