-- Run against an isolated database with waitlist_init and the Bob migration applied.
begin;
do $$
declare
  first_created timestamptz;
  first_verified timestamptz;
  generation uuid;
  result text;
begin
  result := public.waitlist_begin('maya@example.com','bob_landing','aa',600,60);
  if result not like 'sent:%' then raise exception 'first code not issued'; end if;
  if public.waitlist_begin('maya@example.com','bob_landing','bb',600,60) <> 'cooldown' then raise exception 'cooldown bypassed'; end if;
  if public.waitlist_confirm('maya@example.com','aa',5) <> 'verified' then raise exception 'new verification failed'; end if;
  select created_at, verified_at into first_created, first_verified from bob.waitlist where email='maya@example.com';
  if public.waitlist_confirm('maya@example.com','aa',5) <> 'rejected' then raise exception 'replay accepted'; end if;
  update bob.waitlist set last_sent_at=null where email='maya@example.com';
  perform public.waitlist_begin('maya@example.com','bob_landing','bb',600,60);
  if public.waitlist_confirm('maya@example.com','cc',5) <> 'rejected' then raise exception 'returning wrong code accepted'; end if;
  if public.waitlist_confirm('maya@example.com','bb',5) <> 'already_verified' then raise exception 'returning valid code rejected'; end if;
  if exists(select 1 from bob.waitlist where email='maya@example.com' and (created_at<>first_created or verified_at<>first_verified or source<>'bob_landing' or code_hash is not null)) then raise exception 'original membership changed'; end if;
  update bob.waitlist set last_sent_at=null where email='maya@example.com';
  perform public.waitlist_begin('maya@example.com','bob_landing','dd',600,60);
  for i in 1..5 loop perform public.waitlist_confirm('maya@example.com','cc',5); end loop;
  if public.waitlist_confirm('maya@example.com','dd',5) <> 'rejected' then raise exception 'attempt limit bypassed'; end if;
  update bob.waitlist set last_sent_at=null where email='maya@example.com';
  perform public.waitlist_begin('maya@example.com','bob_landing','ee',-1,60);
  if public.waitlist_confirm('maya@example.com','ee',5) <> 'rejected' then raise exception 'expired accepted'; end if;
  select generation_token into generation from bob.waitlist where email='maya@example.com';
  perform public.waitlist_send_failed('maya@example.com',gen_random_uuid());
  if exists(select 1 from bob.waitlist where email='maya@example.com' and code_hash is null) then raise exception 'stale failure cleared code'; end if;
  perform public.waitlist_send_failed('maya@example.com',generation);
  if public.waitlist_begin('maya@example.com','bob_landing','ff',600,60) not like 'sent:%' then raise exception 'SMTP retry blocked'; end if;
  if has_function_privilege('anon','public.waitlist_confirm(text,text,integer)','execute') or has_function_privilege('authenticated','public.waitlist_confirm(text,text,integer)','execute') then raise exception 'public RPC access'; end if;
end $$;
rollback;
