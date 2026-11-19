-- Returning subscribers must prove ownership with a fresh code.
-- CREATE OR REPLACE preserves the existing service-role-only grants.
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
    set verified_at     = coalesce(v_row.verified_at, now()),
        code_hash       = null,
        code_expires_at = null,
        code_attempts   = 0
  where id = v_row.id;

  return case when v_row.verified_at is null then 'verified' else 'already_verified' end;
end;
$$;

