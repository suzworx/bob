-- One owner-row marker, no provider identity or content. Existing conversation
-- RLS and erasure lifecycle apply; no new privileges or security-definer code.
alter table bob.conversations
  add column memory_provider_from_position bigint
  check (memory_provider_from_position >= 0);

comment on column bob.conversations.memory_provider_from_position is
  'Automatic memory extraction excludes this message position and all later turns after external content entered the conversation.';
