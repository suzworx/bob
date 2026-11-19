-- Preserve the original requested scope set for Connect token lookup. This is
-- a credential selector only, never proof of the scopes Google granted.
-- No legacy backfill: the original selector cannot be inferred safely.
alter table bob.google_accounts add column authorization_capabilities text[]
  check (cardinality(authorization_capabilities) between 1 and 4
    and array_position(authorization_capabilities, null) is null
    and authorization_capabilities <@ array['calendar.read','calendar.write','gmail.read','gmail.draft']::text[]);
comment on column bob.google_accounts.authorization_capabilities is
  'Original consent request selector for Connect lookup; actual grants must be independently verified.';
