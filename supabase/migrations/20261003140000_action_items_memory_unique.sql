-- bob:requires-extension vector
-- #757: at most one action item per memory. The code only ever creates one
-- (memory/store.ts applyAdd, createActionItem checks first); this makes the
-- invariant a constraint. The existing non-unique action_items_memory_id_idx
-- stays; dropping it is out of scope.

-- A database that already breaks the invariant must fail the deploy loudly.
-- The message carries only a count, never ids or content.
do $$
declare
  duplicated integer;
begin
  select count(*) into duplicated from (
    select memory_id from bob.action_items group by memory_id having count(*) > 1
  ) d;
  if duplicated > 0 then
    raise exception '% memory id(s) have more than one action item; resolve them before adding action_items_memory_id_key', duplicated;
  end if;
end
$$;

create unique index if not exists action_items_memory_id_key
  on bob.action_items (memory_id);
