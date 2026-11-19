-- Existing invocations remain unbound. Binding is a server-authorized snapshot,
-- not a mutable selector on a running invocation.
alter table bob.ai_invocations add column app_binding jsonb
 check(app_binding is null or jsonb_typeof(app_binding)='object');
create function bob_private.guard_invocation_app_binding() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.app_binding is distinct from old.app_binding then raise insufficient_privilege; end if;
 return new;
end;
$$;
revoke all on function bob_private.guard_invocation_app_binding() from public,anon;
create trigger guard_invocation_app_binding before update on bob.ai_invocations
 for each row execute function bob_private.guard_invocation_app_binding();

-- Denormalized audience is checked against the immutable app audience, allowing
-- SQL uniqueness for packages without restricting multiple generic apps.
alter table bob.bob_app_installations add column space_id uuid references bob.spaces(id) on delete cascade;
update bob.bob_app_installations i set space_id=a.space_id from bob.bob_apps a where a.id=i.app_id;
create unique index bob_app_installations_space_package_key on bob.bob_app_installations(space_id,package_id)
 where kind='package' and space_id is not null;
create function bob_private.guard_installation_space() returns trigger
language plpgsql security invoker set search_path='' as $$
declare audience uuid;
begin
 select space_id into audience from bob.bob_apps where id=new.app_id;
 if tg_op='INSERT' then
  if new.space_id is not null and new.space_id is distinct from audience then raise insufficient_privilege; end if;
  new.space_id:=audience;
 elsif new.space_id is distinct from old.space_id or new.space_id is distinct from audience then
  raise insufficient_privilege;
 end if;
 return new;
end;
$$;
revoke all on function bob_private.guard_installation_space() from public,anon;
create trigger guard_installation_space before insert or update on bob.bob_app_installations
 for each row execute function bob_private.guard_installation_space();

-- A member may open the shared composer, without gaining UPDATE permission on
-- package grants/configuration. One installation resolves exactly one thread.
create table bob.bob_app_conversations (
 installation_id uuid primary key references bob.bob_app_installations(id) on delete cascade,
 conversation_id text not null unique references bob.conversations(id) on delete cascade
);
alter table bob.bob_app_conversations enable row level security;
alter table bob.bob_app_conversations force row level security;
create policy bob_app_conversations_read on bob.bob_app_conversations for select to authenticated
 using(exists(select 1 from bob.bob_app_installations i where i.id=installation_id));
create policy bob_app_conversations_insert on bob.bob_app_conversations for insert to authenticated
 with check(exists(select 1 from bob.bob_app_installations i join bob.bob_apps a on a.id=i.app_id
 join bob.conversations c on c.id=conversation_id
 where i.id=installation_id and a.space_id=c.space_id and c.archived_at is null
 and bob_private.bob_app_space_member(a.space_id)));
grant select,insert on bob.bob_app_conversations to authenticated;

-- Erasure already owns the account admission fence. Take shared audiences next,
-- in one deterministic order, before any membership/attribution changes. App
-- writes and receipt replay wait here and reauthorize after erasure commits.
create function bob_private.lock_account_app_audiences(p_user uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform s.id from bob.spaces s
 where s.kind<>'private' and exists(select 1 from bob.space_memberships m
   where m.space_id=s.id and m.user_id=p_user and m.revoked_at is null)
 order by s.id for update of s;
end;
$$;
revoke all on function bob_private.lock_account_app_audiences(uuid) from public,anon,authenticated;
grant execute on function bob_private.lock_account_app_audiences(uuid) to bob_server;
