-- Sidecars preserve legacy table row shapes and warm prepared SELECT * queries.
create table bob.marketing_review_app_versions (
 app_id uuid primary key references bob.bob_apps(id) on delete cascade,
 generation integer not null default 0 check(generation>=0)
);
create table bob.marketing_review_installation_versions (
 installation_id uuid primary key references bob.bob_app_installations(id) on delete cascade,
 generation integer not null default 0 check(generation>=0)
);
create table bob.marketing_review_campaign_versions (
 installation_id uuid not null, campaign_id uuid primary key,
 generation integer not null default 0 check(generation>=0), review_revision integer not null default 1 check(review_revision>0),
 foreign key(installation_id,campaign_id) references bob.bob_app_campaigns(installation_id,id) on delete cascade
);
create index marketing_review_campaign_versions_installation_idx on bob.marketing_review_campaign_versions(installation_id);
insert into bob.marketing_review_app_versions(app_id) select id from bob.bob_apps;
insert into bob.marketing_review_installation_versions(installation_id) select id from bob.bob_app_installations;
insert into bob.marketing_review_campaign_versions(installation_id,campaign_id) select installation_id,id from bob.bob_app_campaigns;
alter table bob.marketing_review_app_versions enable row level security;
alter table bob.marketing_review_app_versions force row level security;
alter table bob.marketing_review_installation_versions enable row level security;
alter table bob.marketing_review_installation_versions force row level security;
alter table bob.marketing_review_campaign_versions enable row level security;
alter table bob.marketing_review_campaign_versions force row level security;
create policy marketing_review_app_versions_read on bob.marketing_review_app_versions for select to authenticated
 using(exists(select 1 from bob.bob_apps a where a.id=app_id));
create policy marketing_review_installation_versions_read on bob.marketing_review_installation_versions for select to authenticated
 using(exists(select 1 from bob.bob_app_installations i where i.id=installation_id));
create policy marketing_review_campaign_versions_read on bob.marketing_review_campaign_versions for select to authenticated
 using(exists(select 1 from bob.bob_app_campaigns c where c.id=campaign_id and c.installation_id=marketing_review_campaign_versions.installation_id));
grant select on bob.marketing_review_app_versions,bob.marketing_review_installation_versions,bob.marketing_review_campaign_versions to authenticated;

-- Only definer triggers can initialize or advance counters; authenticated SQL
-- receives no mutation grants on the sidecars, so it cannot rewind approvals.
create function bob_private.advance_marketing_review_version() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' then
  if tg_table_name='bob_apps' then insert into bob.marketing_review_app_versions(app_id) values(new.id);
  elsif tg_table_name='bob_app_installations' then insert into bob.marketing_review_installation_versions(installation_id) values(new.id);
  else insert into bob.marketing_review_campaign_versions(installation_id,campaign_id) values(new.installation_id,new.id);
  end if;
 elsif tg_table_name='bob_apps' then
  if new.lifecycle is distinct from old.lifecycle then update bob.marketing_review_app_versions set generation=generation+1 where app_id=new.id; end if;
 elsif tg_table_name='bob_app_installations' then
  if new.state is distinct from old.state then update bob.marketing_review_installation_versions set generation=generation+1 where installation_id=new.id; end if;
 elsif tg_table_name='bob_app_campaigns' then
  if new.status is distinct from old.status then update bob.marketing_review_campaign_versions set generation=generation+1 where campaign_id=new.id; end if;
  if (to_jsonb(new)-array['created_by','updated_at','created_at','revision','user_id'])
   is distinct from (to_jsonb(old)-array['created_by','updated_at','created_at','revision','user_id']) then
   update bob.marketing_review_campaign_versions set review_revision=review_revision+1 where campaign_id=new.id;
  end if;
 end if;
 return new;
end;
$$;
do $$ declare t text; begin
 foreach t in array array['bob_apps','bob_app_installations','bob_app_campaigns'] loop
  execute format('create trigger advance_marketing_review_version after insert or update on bob.%I for each row execute function bob_private.advance_marketing_review_version()',t);
 end loop;
end; $$;
create function bob_private.bump_marketing_review_content() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and (to_jsonb(new)-array['created_by','updated_at','created_at','user_id'])
  is not distinct from (to_jsonb(old)-array['created_by','updated_at','created_at','user_id']) then return new; end if;
 if tg_op='DELETE' then
  update bob.marketing_review_campaign_versions set review_revision=review_revision+1 where campaign_id=old.campaign_id and installation_id=old.installation_id;
  return old;
 end if;
 update bob.marketing_review_campaign_versions set review_revision=review_revision+1 where campaign_id=new.campaign_id and installation_id=new.installation_id;
 return new;
end;
$$;
create trigger bump_marketing_review_draft after insert or update or delete on bob.bob_app_campaign_drafts
 for each row execute function bob_private.bump_marketing_review_content();
create trigger bump_marketing_review_section after insert or update or delete on bob.bob_app_campaign_sections
 for each row execute function bob_private.bump_marketing_review_content();

create table bob.marketing_review_notes (
 id uuid primary key default gen_random_uuid(), installation_id uuid not null, campaign_id uuid not null,
 author_user_id uuid references auth.users(id) on delete set null,
 source_message_id text references bob.messages(id) on delete set null,
 source_conversation_id text references bob.conversations(id) on delete set null,
 text text not null check(char_length(btrim(text)) between 1 and 1000), created_at timestamptz not null default now(),
 foreign key(installation_id,campaign_id) references bob.bob_app_campaigns(installation_id,id) on delete cascade
);
create table bob.marketing_review_decisions (
 id uuid primary key default gen_random_uuid(), installation_id uuid not null, campaign_id uuid not null,
 author_user_id uuid references auth.users(id) on delete set null,
 session_id uuid references auth.sessions(id) on delete set null,
 review_revision integer not null check(review_revision>0), snapshot_hash text not null check(snapshot_hash~'^[0-9a-f]{64}$'),
 created_at timestamptz not null default now(),
 foreign key(installation_id,campaign_id) references bob.bob_app_campaigns(installation_id,id) on delete cascade
);
create table bob.marketing_review_operations (
 actor_user_id uuid not null references auth.users(id) on delete cascade,
 installation_id uuid not null, campaign_id uuid not null, operation_key text not null check(length(operation_key) between 1 and 64),
 fingerprint text not null check(fingerprint~'^[0-9a-f]{64}$'), kind text not null check(kind in ('review.note','review.approved')),
 result_id uuid not null, created_at timestamptz not null default now(),
 primary key(installation_id,actor_user_id,operation_key),
 foreign key(installation_id,campaign_id) references bob.bob_app_campaigns(installation_id,id) on delete cascade
);
create index marketing_review_notes_campaign_idx on bob.marketing_review_notes(installation_id,campaign_id,created_at,id);
create index marketing_review_decisions_campaign_idx on bob.marketing_review_decisions(installation_id,campaign_id,created_at desc,id desc);
create index marketing_review_notes_author_idx on bob.marketing_review_notes(author_user_id) where author_user_id is not null;
create index marketing_review_decisions_author_idx on bob.marketing_review_decisions(author_user_id) where author_user_id is not null;
create index marketing_review_operations_actor_idx on bob.marketing_review_operations(actor_user_id);
create function bob_private.marketing_review_member(p_installation uuid) returns boolean
language sql stable security invoker set search_path='' as $$
 select exists(select 1 from bob.bob_app_installations i where i.id=p_installation
 and i.kind='package' and i.package_id='bob-marketing' and bob_private.bob_app_space_member(i.space_id));
$$;
-- A reader locks the version sidecar without receiving permission to change it.
-- Direct authenticated draft/section SQL then linearizes before or after the
-- complete snapshot, rather than changing its counter between projection reads.
create function bob_private.lock_marketing_review_revision(p_installation uuid,p_campaign uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not bob_private.marketing_review_member(p_installation) then return false; end if;
 perform campaign_id from bob.marketing_review_campaign_versions
 where installation_id=p_installation and campaign_id=p_campaign for update;
 return found;
end;
$$;
do $$ declare t text; begin
 foreach t in array array['marketing_review_notes','marketing_review_decisions','marketing_review_operations'] loop
  execute format('alter table bob.%I enable row level security',t);
  execute format('alter table bob.%I force row level security',t);
  execute format('create policy %I on bob.%I for select to authenticated using(bob_private.marketing_review_member(installation_id))',t||'_read',t);
  execute format('grant select,insert on bob.%I to authenticated',t);
 end loop;
end; $$;
create policy marketing_review_notes_insert on bob.marketing_review_notes for insert to authenticated
 with check(author_user_id=auth.uid() and bob_private.marketing_review_member(installation_id)
 and exists(select 1 from bob.messages m join bob.conversations c on c.id=m.conversation_id
 join bob.bob_app_installations i on i.id=installation_id where m.id=source_message_id and c.id=source_conversation_id
 and m.author_user_id=auth.uid() and m.role='user' and m.tombstoned_at is null and c.archived_at is null and c.space_id=i.space_id));
create policy marketing_review_decisions_insert on bob.marketing_review_decisions for insert to authenticated
 with check(author_user_id=auth.uid() and bob_private.marketing_review_member(installation_id)
 and bob_private.marketing_session_active(session_id)
 and exists(select 1 from bob.bob_app_installations i where i.id=installation_id and bob_private.is_space_owner_or_admin(i.space_id)));
create policy marketing_review_operations_insert on bob.marketing_review_operations for insert to authenticated
 with check(actor_user_id=auth.uid() and bob_private.marketing_review_member(installation_id));

create function bob_private.guard_marketing_review_note_limit() returns trigger
language plpgsql security invoker set search_path='' as $$
declare audience uuid; locked integer;
begin
 select space_id into audience from bob.bob_app_installations where id=new.installation_id;
 select bob_private.lock_thread_audience_revision(audience) into locked;
 if locked is null then raise insufficient_privilege; end if;
 if (select count(*) from bob.marketing_review_notes where installation_id=new.installation_id and campaign_id=new.campaign_id)>=100 then
  raise exception 'review_note_limit';
 end if;
 return new;
end;
$$;
create trigger guard_marketing_review_note_limit before insert on bob.marketing_review_notes
 for each row execute function bob_private.guard_marketing_review_note_limit();

-- Extend the established erasure function without removing retained team work.
create or replace function bob_private.purge_bob_apps(owner_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare t text;
begin
 update bob.marketing_review_notes set author_user_id=null,source_message_id=null,source_conversation_id=null where author_user_id=owner_id;
 update bob.marketing_review_decisions set author_user_id=null,session_id=null where author_user_id=owner_id;
 delete from bob.marketing_review_operations where actor_user_id=owner_id;
 delete from bob.bob_app_campaign_selection where user_id=owner_id;
 delete from bob.marketing_config_operations where user_id=owner_id;
 delete from bob.bob_app_campaign_operations where user_id=owner_id;
 delete from bob.bob_app_selection where user_id=owner_id;
 delete from bob.bob_app_marketing_operations where user_id=owner_id;
 delete from bob.bob_apps where user_id=owner_id and space_id is null;
 delete from bob.bob_app_mutations where user_id=owner_id;
 foreach t in array array['bob_apps','bob_app_installations','bob_app_campaigns','bob_app_campaign_sections','bob_app_campaign_drafts','marketing_config_proposals','marketing_config_versions'] loop
  execute format('update bob.%I set created_by=null where created_by=$1',t) using owner_id;
 end loop;
 update auth.users set raw_app_meta_data=jsonb_set(coalesce(raw_app_meta_data,'{}'::jsonb),
 '{bob_marketing_erased_before}',to_jsonb(extract(epoch from clock_timestamp())),true) where id=owner_id;
end; $$;
revoke all on function bob_private.advance_marketing_review_version(),bob_private.bump_marketing_review_content() from public,anon,authenticated;
revoke all on function bob_private.guard_marketing_review_note_limit() from public,anon,authenticated;
revoke all on function bob_private.marketing_review_member(uuid) from public,anon;
grant execute on function bob_private.marketing_review_member(uuid) to authenticated;
revoke all on function bob_private.lock_marketing_review_revision(uuid,uuid) from public,anon;
grant execute on function bob_private.lock_marketing_review_revision(uuid,uuid) to authenticated;
revoke all on function bob_private.purge_bob_apps(uuid) from public,anon,authenticated;
grant execute on function bob_private.purge_bob_apps(uuid) to bob_server;
