-- Expand ownership without moving or deleting personal data. user_id remains the
-- cascading PERSONAL owner; shared resources use space_id and nullable attribution.
alter table bob.bob_apps
 add column space_id uuid references bob.spaces(id) on delete cascade,
 add column created_by uuid default auth.uid() references auth.users(id) on delete set null,
 alter column user_id drop not null;
update bob.bob_apps set created_by=user_id;
alter table bob.bob_apps add constraint bob_apps_audience_check
 check ((space_id is null and user_id is not null) or (space_id is not null and user_id is null));
alter table bob.bob_apps drop constraint bob_apps_lifecycle_check;
alter table bob.bob_apps add constraint bob_apps_lifecycle_check check (lifecycle in ('draft','active','paused','archived'));
create index bob_apps_space_idx on bob.bob_apps(space_id,id) where space_id is not null;

alter table bob.bob_app_installations
 add column kind text not null default 'package' check(kind in ('generic','package')),
 add column created_by uuid default auth.uid() references auth.users(id) on delete set null,
 alter column user_id drop not null,
 alter column package_id drop not null,
 alter column package_version drop not null;
update bob.bob_app_installations set created_by=user_id;
alter table bob.bob_app_installations drop constraint bob_app_installations_user_id_app_id_fkey;
alter table bob.bob_app_installations add constraint bob_app_installations_app_fkey
 foreign key(app_id) references bob.bob_apps(id) on delete cascade;
alter table bob.bob_app_installations add constraint bob_app_installations_package_shape_check
 check ((kind='package' and package_id is not null and package_version is not null)
 or (kind='generic' and package_id is null and package_version is null and granted_capabilities='{}'::text[] and config='{}'::jsonb));
insert into bob.bob_app_installations(user_id,app_id,kind,created_by,state)
 select a.user_id,a.id,'generic',a.created_by,
 case a.lifecycle when 'active' then 'active' when 'archived' then 'inactive' when 'paused' then 'paused' else 'draft' end
 from bob.bob_apps a where not exists(select 1 from bob.bob_app_installations i where i.app_id=a.id);

-- Content belongs to its installation. Existing user_id values keep personal
-- erasure cascades; later shared writes use NULL there and created_by for credit.
do $$
declare t text; c record;
begin
 foreach t in array array['bob_app_campaigns','bob_app_campaign_sections','bob_app_campaign_drafts','marketing_config_proposals','marketing_config_versions'] loop
  execute format('alter table bob.%I add column created_by uuid default auth.uid() references auth.users(id) on delete set null, alter column user_id drop not null',t);
  execute format('update bob.%I set created_by=user_id',t);
 end loop;
 foreach t in array array['bob_app_campaigns','bob_app_campaign_sections','bob_app_campaign_drafts','bob_app_campaign_selection','bob_app_campaign_operations','marketing_config_proposals','marketing_config_versions','marketing_config_operations','bob_app_selection'] loop
  for c in select conname from pg_constraint where conrelid=('bob.'||t)::regclass and contype='f'
   and confrelid in ('bob.bob_app_installations'::regclass,'bob.bob_app_campaigns'::regclass,'bob.conversations'::regclass,'bob.marketing_config_proposals'::regclass) loop
   execute format('alter table bob.%I drop constraint %I',t,c.conname);
  end loop;
 end loop;
end;
$$;
alter table bob.bob_app_campaigns add constraint bob_app_campaigns_installation_id_key unique(installation_id,id);
alter table bob.bob_app_campaigns add constraint campaigns_installation_fk foreign key(installation_id) references bob.bob_app_installations(id) on delete cascade;
alter table bob.bob_app_campaign_sections add constraint sections_campaign_fk foreign key(installation_id,campaign_id) references bob.bob_app_campaigns(installation_id,id) on delete cascade;
alter table bob.bob_app_campaign_drafts add constraint drafts_campaign_fk foreign key(installation_id,campaign_id) references bob.bob_app_campaigns(installation_id,id) on delete cascade;
alter table bob.bob_app_campaign_selection add constraint campaign_selection_installation_fk foreign key(installation_id) references bob.bob_app_installations(id) on delete cascade;
alter table bob.bob_app_campaign_selection add constraint campaign_selection_campaign_fk foreign key(installation_id,campaign_id) references bob.bob_app_campaigns(installation_id,id) on delete cascade;
alter table bob.bob_app_campaign_selection add constraint campaign_selection_conversation_fk foreign key(conversation_id) references bob.conversations(id) on delete cascade;
alter table bob.bob_app_campaign_operations add constraint campaign_operations_installation_fk foreign key(installation_id) references bob.bob_app_installations(id) on delete cascade;
alter table bob.marketing_config_proposals add constraint config_proposals_installation_fk foreign key(installation_id) references bob.bob_app_installations(id) on delete cascade;
alter table bob.marketing_config_versions add constraint config_versions_installation_fk foreign key(installation_id) references bob.bob_app_installations(id) on delete cascade;
alter table bob.marketing_config_proposals add constraint config_proposals_installation_id_key unique(installation_id,id);
alter table bob.marketing_config_versions add constraint config_versions_proposal_fk foreign key(installation_id,source_proposal_id)
 references bob.marketing_config_proposals(installation_id,id) on delete set null(source_proposal_id);
alter table bob.marketing_config_operations add constraint config_operations_installation_fk foreign key(installation_id) references bob.bob_app_installations(id) on delete cascade;
alter table bob.marketing_config_operations drop constraint marketing_config_operations_pkey;
alter table bob.marketing_config_operations add primary key(user_id,installation_id,mutation_id);
alter table bob.bob_app_selection add constraint app_selection_installation_fk foreign key(installation_id) references bob.bob_app_installations(id) on delete cascade;

-- No parent FK on generic receipt results: deletion retries must retain their
-- proof. Audience metadata authorizes a delete replay after the app has gone.
alter table bob.bob_app_mutations
 add column installation_id uuid not null default gen_random_uuid(),
 add column target_app_id uuid,
 add column space_id uuid;
update bob.bob_app_mutations m set installation_id=coalesce((select id from bob.bob_app_installations i where i.app_id=m.app_id),m.app_id,m.mutation_id);
update bob.bob_app_mutations set target_app_id=app_id;
alter table bob.bob_app_mutations drop constraint bob_app_mutations_pkey;
alter table bob.bob_app_mutations add primary key(user_id,installation_id,mutation_id);
create index bob_app_mutations_app_idx on bob.bob_app_mutations(user_id,app_id,mutation_id);

create function bob_private.bob_app_space_member(p_space uuid) returns boolean
language sql stable security invoker set search_path='' as $$
 select exists(select 1 from bob.spaces s where s.id=p_space and s.kind='group'
 and s.conversation_id is null and s.archived_at is null and bob_private.is_space_member(s.id));
$$;
revoke all on function bob_private.bob_app_space_member(uuid) from public,anon;
grant execute on function bob_private.bob_app_space_member(uuid) to authenticated;

create function bob_private.bob_app_installation_access(p_installation uuid) returns boolean
language sql stable security invoker set search_path='' as $$
 select exists(select 1 from bob.bob_app_installations i where i.id=p_installation and i.kind='package' and i.package_id='bob-marketing');
$$;
revoke all on function bob_private.bob_app_installation_access(uuid) from public,anon;
grant execute on function bob_private.bob_app_installation_access(uuid) to authenticated;

drop policy bob_apps_owner on bob.bob_apps;
create policy bob_apps_owner on bob.bob_apps for select to authenticated
 using ((space_id is null and user_id=(select auth.uid())) or bob_private.bob_app_space_member(space_id));
create policy bob_apps_insert on bob.bob_apps for insert to authenticated
 with check ((space_id is null and user_id=(select auth.uid())) or (user_id is null and bob_private.bob_app_space_member(space_id)));
create policy bob_apps_update on bob.bob_apps for update to authenticated
 using ((space_id is null and user_id=(select auth.uid())) or bob_private.bob_app_space_member(space_id))
 with check ((space_id is null and user_id=(select auth.uid())) or (user_id is null and bob_private.bob_app_space_member(space_id)));
create policy bob_apps_delete on bob.bob_apps for delete to authenticated
 using ((space_id is null and user_id=(select auth.uid())) or (bob_private.bob_app_space_member(space_id) and bob_private.is_space_owner_or_admin(space_id)));

-- UPDATE RLS cannot compare OLD and NEW columns. This guard keeps membership
-- content editing from becoming ownership, lifecycle or grant administration.
create function bob_private.guard_bob_app_audience() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if current_user<>'authenticated' then return new; end if;
 if tg_op='INSERT' then
  if new.created_by is distinct from auth.uid() then raise insufficient_privilege; end if;
  if new.space_id is not null and new.lifecycle<>'draft' then raise insufficient_privilege; end if;
 else
  if new.space_id is distinct from old.space_id or new.user_id is distinct from old.user_id or new.created_by is distinct from old.created_by then raise insufficient_privilege; end if;
  if old.space_id is not null and not bob_private.is_space_owner_or_admin(old.space_id)
   and (new.lifecycle is distinct from old.lifecycle or new.definition is distinct from old.definition or new.undo_definition is distinct from old.undo_definition) then raise insufficient_privilege; end if;
 end if;
 return new;
end;
$$;
revoke all on function bob_private.guard_bob_app_audience() from public,anon;
create trigger guard_bob_app_audience before insert or update on bob.bob_apps for each row execute function bob_private.guard_bob_app_audience();

drop policy bob_app_installations_owner on bob.bob_app_installations;
create policy bob_app_installations_owner on bob.bob_app_installations for select to authenticated
 using (exists(select 1 from bob.bob_apps a where a.id=app_id));
create policy bob_app_installations_insert on bob.bob_app_installations for insert to authenticated
 with check (exists(select 1 from bob.bob_apps a where a.id=app_id and bob_app_installations.user_id is not distinct from a.user_id
 and (a.space_id is null or kind='generic' or bob_private.is_space_owner_or_admin(a.space_id))));
create policy bob_app_installations_update on bob.bob_app_installations for update to authenticated
 using (exists(select 1 from bob.bob_apps a where a.id=app_id and (a.space_id is null or bob_private.is_space_owner_or_admin(a.space_id))))
 with check (exists(select 1 from bob.bob_apps a where a.id=app_id and bob_app_installations.user_id is not distinct from a.user_id
 and (a.space_id is null or bob_private.is_space_owner_or_admin(a.space_id))));
create function bob_private.guard_bob_app_installation() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if current_user='authenticated' and (new.kind is distinct from old.kind or new.app_id is distinct from old.app_id
 or new.user_id is distinct from old.user_id or new.created_by is distinct from old.created_by) then raise insufficient_privilege; end if;
 return new;
end;
$$;
revoke all on function bob_private.guard_bob_app_installation() from public,anon;
create trigger guard_bob_app_installation before update on bob.bob_app_installations for each row execute function bob_private.guard_bob_app_installation();

create function bob_private.ensure_bob_app_installation(p_app uuid) returns uuid
language plpgsql security invoker set search_path='' as $$
declare result uuid;
begin
 insert into bob.bob_app_installations(user_id,app_id,kind,created_by,state)
 select a.user_id,a.id,'generic',a.created_by,
 case a.lifecycle when 'active' then 'active' when 'archived' then 'inactive' when 'paused' then 'paused' else 'draft' end
 from bob.bob_apps a where a.id=p_app and not exists(select 1 from bob.bob_app_installations i where i.app_id=a.id)
 on conflict(app_id) do nothing;
 select id into result from bob.bob_app_installations where app_id=p_app;
 return result;
end;
$$;
revoke all on function bob_private.ensure_bob_app_installation(uuid) from public,anon;
grant execute on function bob_private.ensure_bob_app_installation(uuid) to authenticated;
create function bob_private.ensure_bob_app_installation_on_commit() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 perform bob_private.ensure_bob_app_installation(new.id);
 return new;
end;
$$;
revoke all on function bob_private.ensure_bob_app_installation_on_commit() from public,anon;
create constraint trigger ensure_bob_app_installation_on_commit after insert on bob.bob_apps
 deferrable initially deferred for each row execute function bob_private.ensure_bob_app_installation_on_commit();

drop policy bob_app_mutations_owner on bob.bob_app_mutations;
create policy bob_app_mutations_owner on bob.bob_app_mutations for select to authenticated
 using (user_id=(select auth.uid()) and (space_id is null or bob_private.bob_app_space_member(space_id)));
create policy bob_app_mutations_insert on bob.bob_app_mutations for insert to authenticated
 with check (user_id=(select auth.uid()) and (space_id is null or bob_private.bob_app_space_member(space_id)));
create policy bob_app_mutations_delete on bob.bob_app_mutations for delete to authenticated using(user_id=(select auth.uid()));

-- Replace every old owner policy; child reads/writes follow the installation.
do $$
declare t text; p text;
begin
 foreach t in array array['bob_app_campaigns','bob_app_campaign_sections','bob_app_campaign_drafts','marketing_config_proposals','marketing_config_versions','bob_app_campaign_operations','marketing_config_operations'] loop
  for p in select policyname from pg_policies where schemaname='bob' and tablename=t loop
   execute format('drop policy %I on bob.%I',p,t);
  end loop;
  execute format('create policy %I on bob.%I for select to authenticated using(bob_private.bob_app_installation_access(installation_id))',t||'_owner',t);
  if t in ('bob_app_campaign_operations','marketing_config_operations') then
   execute format('create policy %I on bob.%I for insert to authenticated with check(user_id=auth.uid() and bob_private.bob_app_installation_access(installation_id))',t||'_insert',t);
  else
   execute format('create policy %I on bob.%I for insert to authenticated with check(bob_private.bob_app_installation_access(installation_id) and exists(select 1 from bob.bob_app_installations i where i.id=installation_id and %I.user_id is not distinct from i.user_id))',t||'_insert',t,t);
   execute format('create policy %I on bob.%I for update to authenticated using(bob_private.bob_app_installation_access(installation_id)) with check(bob_private.bob_app_installation_access(installation_id) and exists(select 1 from bob.bob_app_installations i where i.id=installation_id and %I.user_id is not distinct from i.user_id))',t||'_update',t,t);
  end if;
 end loop;
end;
$$;
create function bob_private.guard_bob_app_content() returns trigger
language plpgsql security invoker set search_path='' as $$
declare audience uuid; manager boolean;
begin
 if current_user<>'authenticated' then return new; end if;
 select a.space_id into audience from bob.bob_app_installations i join bob.bob_apps a on a.id=i.app_id where i.id=new.installation_id;
 if audience is null then return new; end if;
 manager:=bob_private.is_space_owner_or_admin(audience);
 if tg_op='INSERT' then
  if new.created_by is distinct from auth.uid() then raise insufficient_privilege; end if;
  if tg_table_name='marketing_config_versions' and not manager then raise insufficient_privilege; end if;
  if tg_table_name='marketing_config_proposals' and to_jsonb(new)->>'status'<>'pending' and not manager then raise insufficient_privilege; end if;
 else
  if new.installation_id is distinct from old.installation_id or new.user_id is distinct from old.user_id
   or new.created_by is distinct from old.created_by or to_jsonb(new)->'campaign_id' is distinct from to_jsonb(old)->'campaign_id' then raise insufficient_privilege; end if;
  if tg_table_name in ('bob_app_campaigns','marketing_config_proposals')
   and to_jsonb(new)->'status' is distinct from to_jsonb(old)->'status' and not manager then raise insufficient_privilege; end if;
 end if;
 return new;
end;
$$;
revoke all on function bob_private.guard_bob_app_content() from public,anon;
do $$
declare t text;
begin
 foreach t in array array['bob_app_campaigns','bob_app_campaign_sections','bob_app_campaign_drafts','marketing_config_proposals','marketing_config_versions'] loop
  execute format('create trigger guard_bob_app_content before insert or update on bob.%I for each row execute function bob_private.guard_bob_app_content()',t);
 end loop;
end;
$$;
create index bob_app_drafts_installation_idx on bob.bob_app_campaign_drafts(installation_id,campaign_id,id);
-- Config history pruning/proposal cleanup remains admin-only for shared apps.
create policy marketing_config_versions_delete on bob.marketing_config_versions for delete to authenticated
 using(exists(select 1 from bob.bob_app_installations i join bob.bob_apps a on a.id=i.app_id where i.id=installation_id and (a.space_id is null or bob_private.is_space_owner_or_admin(a.space_id))));
create policy marketing_config_proposals_delete on bob.marketing_config_proposals for delete to authenticated
 using(exists(select 1 from bob.bob_app_installations i join bob.bob_apps a on a.id=i.app_id where i.id=installation_id and (a.space_id is null or bob_private.is_space_owner_or_admin(a.space_id))));

drop policy bob_app_selection_owner on bob.bob_app_selection;
create policy bob_app_selection_owner on bob.bob_app_selection for all to authenticated
 using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()) and bob_private.bob_app_installation_access(installation_id));
drop policy bob_app_campaign_selection_owner on bob.bob_app_campaign_selection;
create policy bob_app_campaign_selection_owner on bob.bob_app_campaign_selection for all to authenticated
 using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()) and bob_private.bob_app_installation_access(installation_id)
 and exists(select 1 from bob.conversations c join bob.bob_app_installations i on i.id=installation_id join bob.bob_apps a on a.id=i.app_id
 where c.id=conversation_id and ((a.space_id is null and c.user_id=auth.uid() and exists(select 1 from bob.spaces s where s.id=c.space_id and s.kind='private')) or a.space_id=c.space_id)));

-- Shared refresh is intentionally unavailable. Existing personal jobs/settings
-- and their cascades are unchanged; a shared app cannot bind personal sources.
create function bob_private.guard_bob_app_refresh_audience() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if exists(select 1 from bob.bob_apps a where a.id=new.app_id and a.space_id is not null) then raise insufficient_privilege; end if;
 return new;
end;
$$;
revoke all on function bob_private.guard_bob_app_refresh_audience() from public,anon;
create trigger guard_bob_app_refresh_audience before insert or update on bob.bob_app_refresh_settings for each row execute function bob_private.guard_bob_app_refresh_audience();

create or replace function bob_private.purge_bob_apps(owner_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare t text;
begin
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
end;
$$;
revoke all on function bob_private.purge_bob_apps(uuid) from public,anon,authenticated;
grant execute on function bob_private.purge_bob_apps(uuid) to bob_server;
