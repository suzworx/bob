-- Bob public waitlist: the landing page's interest list.
--
-- Follows the bob-init assembly order: 1 schema · 2 table · 3 indexes ·
-- 4 enable/force RLS. No functions, no grants: see "Who can touch this" below.
-- No vector / pg_cron / pgmq and no non-immutable function in an index
-- predicate.
--
-- WHY THERE IS NO AUTH ACCOUNT HERE. The obvious way to prove someone owns an
-- address is Supabase Auth's email OTP, but signInWithOtp needs
-- shouldCreateUser, which needs [auth] enable_signup -- and Bob is
-- invite-only by design, with scripts/invite-only.test.ts pinning that switch
-- to false, forbidding signUp() in the UI, and requiring every
-- signInWithOtp() to pass shouldCreateUser: false. A marketing list is not a
-- good enough reason to retire that guarantee.
--
-- So a waitlist entry is just a row here. The code that proves the address is
-- generated, hashed and checked by the `waitlist` Edge Function; nothing in
-- this flow creates an auth.users row, and nobody on the list can obtain a
-- JWT. Members become real accounts later through the existing admin-API
-- invite flow -- which is what a waitlist is for.
--
-- WHO CAN TOUCH THIS. No browser, by any route. The table is in the `bob`
-- schema, which is not in config.toml's [api] schemas list, so it has no
-- PostgREST endpoint; RLS is enabled and forced with zero policies, so
-- "unreachable" and "denied" give the same answer even if the schema is
-- exposed later by mistake. The two definer functions at the end of this file
-- are the only way in, and they are granted to service_role alone -- anon and
-- authenticated are explicitly revoked, so they are not the anon-callable
-- definers that would amount to a public endpoint. See the note above them.
--
-- Re-running this file will not error: every create is `if not exists`. That
-- is not the same as converging the schema -- `create table if not exists`
-- skips a table that already exists whatever its shape -- so inspect an
-- existing bob.waitlist before relying on a re-run.

create schema if not exists bob;

-- The code is stored as sha256(code || pepper), never in clear: this table is
-- the one place a database backup could otherwise leak live credentials. The
-- pepper lives in the Edge Function's secrets, so a stolen dump alone does not
-- let an attacker precompute the 10^6 possible digests.
create table if not exists bob.waitlist (
  id              uuid primary key default gen_random_uuid(),
  email           text not null
                  check (char_length(email) between 3 and 254)
                  -- Not RFC 5322. A loose shape check that rejects obvious
                  -- junk without bouncing real addresses; the authoritative
                  -- test is whether the code arrives.
                  check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  source          text not null default 'landing'
                  check (char_length(source) between 1 and 40),

  -- Verification state. All four reset together on each new code request.
  code_hash       bytea null,
  code_expires_at timestamptz null,
  code_attempts   smallint not null default 0
                  check (code_attempts >= 0),
  last_sent_at    timestamptz null,
  generation_token uuid not null default gen_random_uuid(),

  -- Set once, on the first successful verification. A second signup from the
  -- same address is idempotent rather than a second row.
  verified_at     timestamptz null,

  created_at      timestamptz not null default now()
);

-- Unique on lower(email) so Ann@ and ann@ are one person; it is what the
-- function's upsert resolves against.
create unique index if not exists waitlist_email_unique_idx
  on bob.waitlist (lower(email));
-- Listing verified members for the launch mail-out, newest first.
create index if not exists waitlist_verified_idx
  on bob.waitlist (verified_at desc);

alter table bob.waitlist enable row level security;
alter table bob.waitlist force row level security;

-- HOW THE EDGE FUNCTION REACHES THIS TABLE.
--
-- Not with supabase-js against the `bob` schema: PostgREST only serves the
-- schemas in config.toml's [api] schemas list, and `bob` is deliberately not
-- one of them. A client configured with db.schema = 'bob' gets
-- `PGRST106 Invalid schema` no matter which key it holds -- the service role
-- bypasses RLS, not the schema allow-list.
--
-- So the two operations live in `public`, which is served, as definer
-- functions granted to service_role ALONE. This is not the anon-callable
-- definer the header warns about: anon and authenticated are revoked, so these
-- are not reachable from a browser at all, only from a function holding the
-- service key.
--
-- The hash crosses as plain hex TEXT, decoded with decode(..., 'hex') inside,
-- rather than as bytea. A bytea argument would depend on PostgREST coercing a
-- JSON string through byteain, which is one more assumption than this needs --
-- and the last assumption of that kind in this file cost a deploy-only bug.
--
-- Putting them in SQL also makes each operation a single atomic statement.
-- The cooldown check and the attempt counter were a read-then-write in the
-- Edge Function, which two simultaneous requests could interleave -- two codes
-- mailed for one address, or an attempt not counted. Here they cannot.

-- Begins a verification: stores the hash and stamps last_sent_at, unless the
-- address is still inside its cooldown. Returns 'sent' when the caller should
-- mail the code, 'cooldown' when it must not. The row is created on first use.
create or replace function public.waitlist_begin(
  p_email            text,
  p_source           text,
  p_code_hash_hex    text,
  p_ttl_seconds      integer,
  p_cooldown_seconds integer
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email  text := lower(btrim(p_email));
  v_now    timestamptz := now();
  v_hash   bytea := decode(p_code_hash_hex, 'hex');
  v_result text;
begin
  insert into bob.waitlist (email, source, code_hash, code_expires_at, code_attempts, last_sent_at, generation_token)
  values (
    v_email,
    coalesce(nullif(left(btrim(p_source), 40), ''), 'landing'),
    v_hash,
    v_now + make_interval(secs => p_ttl_seconds),
    0,
    v_now,
    gen_random_uuid()
  )
  on conflict (lower(email)) do update
    set code_hash       = excluded.code_hash,
        code_expires_at = excluded.code_expires_at,
        code_attempts   = 0,
        last_sent_at    = v_now,
        generation_token = gen_random_uuid()
    -- The cooldown lives in the conflict predicate, so the decision and the
    -- write are one statement: a second request inside the window updates no
    -- row and returns nothing, leaving the live code untouched.
    where bob.waitlist.last_sent_at is null
       or bob.waitlist.last_sent_at < v_now - make_interval(secs => p_cooldown_seconds)
  returning 'sent:' || generation_token::text into v_result;

  return coalesce(v_result, 'cooldown');
end;
$$;

-- Confirms a code. Returns 'verified' only when this submitted code matches,
-- and 'rejected' for every other case -- wrong
-- hash, expired, out of attempts, or no such address -- so the caller cannot
-- tell them apart. A wrong hash burns one attempt.
create or replace function public.waitlist_confirm(
  p_email        text,
  p_code_hash_hex text,
  p_max_attempts integer
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(p_email));
  v_hash  bytea := decode(p_code_hash_hex, 'hex');
  v_row   bob.waitlist%rowtype;
begin
  -- Lock the row for the read-modify-write below; two submissions racing must
  -- not both spend the same attempt budget.
  select * into v_row from bob.waitlist where lower(email) = v_email for update;

  if not found then
    return 'rejected';
  end if;
  if v_row.verified_at is not null then
    return 'rejected';
  end if;
  if v_row.code_hash is null
     or v_row.code_expires_at is null
     or v_row.code_expires_at < now()
     or v_row.code_attempts >= p_max_attempts then
    return 'rejected';
  end if;

  if v_row.code_hash <> v_hash then
    update bob.waitlist set code_attempts = code_attempts + 1 where id = v_row.id;
    return 'rejected';
  end if;

  -- Clear the code on success: it must not be replayable.
  update bob.waitlist
    set verified_at     = now(),
        code_hash       = null,
        code_expires_at = null,
        code_attempts   = 0
  where id = v_row.id;

  return 'verified';
end;
$$;

-- Clears a code after delivery failure, but only if it is still the code that
-- failed. A slower failed request must not erase a newer successful request.
create or replace function public.waitlist_send_failed(
  p_email text,
  p_generation_token uuid
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update bob.waitlist
     set code_hash = null, code_expires_at = null, last_sent_at = null,
         code_attempts = 0
   where lower(email) = lower(btrim(p_email))
     and generation_token = p_generation_token;
$$;

-- service_role only. Revoking `public` covers anon and authenticated, which
-- inherit from it; they are named again for the benefit of anyone reading this
-- file to answer "can a browser call these". They cannot.
revoke all on function public.waitlist_begin(text, text, text, integer, integer) from public;
revoke all on function public.waitlist_confirm(text, text, integer) from public;
revoke all on function public.waitlist_send_failed(text, uuid) from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.waitlist_begin(text, text, text, integer, integer) from anon;
    revoke all on function public.waitlist_confirm(text, text, integer) from anon;
    revoke all on function public.waitlist_send_failed(text, uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.waitlist_begin(text, text, text, integer, integer) from authenticated;
    revoke all on function public.waitlist_confirm(text, text, integer) from authenticated;
    revoke all on function public.waitlist_send_failed(text, uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.waitlist_begin(text, text, text, integer, integer) to service_role;
    grant execute on function public.waitlist_confirm(text, text, integer) to service_role;
    grant execute on function public.waitlist_send_failed(text, uuid) to service_role;
  end if;
end $$;
