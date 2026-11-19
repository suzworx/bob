-- Preserve old selectors exactly; new permissions require a fresh explicit consent.
alter table bob.google_accounts drop constraint google_accounts_authorization_capabilities_check;
alter table bob.google_accounts add constraint google_accounts_authorization_capabilities_check
  check (cardinality(authorization_capabilities) between 1 and 6
    and array_position(authorization_capabilities, null) is null
    and authorization_capabilities <@ array['calendar.read','calendar.write','gmail.read','gmail.draft','gmail.send','gmail.modify']::text[]);
alter table bob.google_consent_attempts drop constraint google_consent_attempts_capabilities_check;
alter table bob.google_consent_attempts add constraint google_consent_attempts_capabilities_check
  check (cardinality(capabilities) between 1 and 6
    and array_position(capabilities, null) is null
    and capabilities <@ array['calendar.read','calendar.write','gmail.read','gmail.draft','gmail.send','gmail.modify']::text[]);
comment on column bob.google_accounts.authorization_capabilities is
  'Original explicit product consent and Connect lookup selector; intersect with independently verified actual provider grants.';
