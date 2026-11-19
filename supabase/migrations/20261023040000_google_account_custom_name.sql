-- A private display label, independent of verified Google identity and grants.
alter table bob.google_accounts add column custom_name text
  check (custom_name is null or (length(custom_name) between 1 and 60 and custom_name = btrim(custom_name)));
comment on column bob.google_accounts.custom_name is
  'Owner-chosen display name; never credential or authorization evidence.';
