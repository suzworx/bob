# Supabase Observability report: SQL blocks

These queries fill a custom report in the Supabase dashboard (Observability,
then Reports) with Bob usage and health charts. Supabase has no public API or
CLI command to edit a custom report, so you add each block by hand and paste the
query from this page.

Every query is read-only and shows aggregates only: counts, sums, percentiles
and sizes. None selects an id, an email, a name or any message text. They run in
Supabase Studio as the `postgres` role, and a CI test
(`apps/api/tests/platform/supabase-report-sql.test.ts`) runs every block against
a real Postgres so none of them can be broken. A query that finds no rows draws
an empty chart, which is fine on a quiet project.

## How to add a block

1. Open the project in the Supabase dashboard, then Observability, then Reports,
   and open your custom report.
2. Choose "Add block" and pick a SQL block.
3. Paste one query from this page. Where it says `interval '30 days'` or
   `interval '7 days'`, edit the number to widen or narrow the window.
4. Run it, pick the chart type named under the heading, and save the report.

## Blocks

### 1. Turns per day by surface (30 days)
Chart: stacked bar. User turns per day, split by where they were spoken or typed (device, web voice, web text); tall bars are busy days.
```sql
select date_trunc('day', created_at)::date as day,
       count(*) filter (where origin = 'device') as device,
       count(*) filter (where origin = 'web_voice') as web_voice,
       count(*) filter (where origin = 'web_text') as web_text
  from bob.messages
 where role = 'user'
   and tombstoned_at is null
   and created_at >= now() - interval '30 days'
 group by 1
 order by 1;
```

### 2. Active accounts per day
Chart: line. How many distinct accounts sent at least one turn each day; a rising line means more people are using Bob.
```sql
select date_trunc('day', created_at)::date as day,
       count(distinct user_id) as active_accounts
  from bob.messages
 where role = 'user'
   and tombstoned_at is null
   and created_at >= now() - interval '30 days'
 group by 1
 order by 1;
```

### 3. New sign-ups per day
Chart: bar. Accounts created per day in Supabase Auth; read it as the growth rate.
```sql
select date_trunc('day', created_at)::date as day,
       count(*) as signups
  from auth.users
 where created_at >= now() - interval '30 days'
 group by 1
 order by 1;
```

### 4. Turn outcomes per day
Chart: stacked bar. Every recorded turn per day by how it ended; the red slice (failed) should stay small.
```sql
select date_trunc('day', occurred_at)::date as day,
       count(*) filter (where outcome = 'completed') as completed,
       count(*) filter (where outcome = 'failed') as failed,
       count(*) filter (where outcome = 'cancelled') as cancelled,
       count(*) filter (where outcome = 'empty') as empty
  from bob.turn_metrics
 where occurred_at >= now() - interval '30 days'
 group by 1
 order by 1;
```

### 5. First-audio latency per day, device
Chart: line. Milliseconds until the first audio plays on the Cardputer, median (p50) and slow tail (p95); lower is better.
```sql
select date_trunc('day', occurred_at)::date as day,
       round(percentile_cont(0.5) within group (order by first_audio_ms))::int as p50_ms,
       round(percentile_cont(0.95) within group (order by first_audio_ms))::int as p95_ms
  from bob.turn_metrics
 where surface = 'device'
   and first_audio_ms is not null
   and occurred_at >= now() - interval '30 days'
 group by 1
 order by 1;
```

### 6. Failed turns by stage (7 days)
Chart: bar. Where failed turns broke: input, speech-to-text, the agent, or text-to-speech; the tallest bar is the stage to look at first.
```sql
select failed_stage as stage,
       count(*) as failed_turns
  from bob.turn_metrics
 where outcome = 'failed'
   and occurred_at >= now() - interval '7 days'
 group by 1
 order by 2 desc;
```

### 7. Tokens per day
Chart: line. Model input, output and cached input tokens summed per day; it is the cost driver, so watch for a climbing line.
```sql
select date_trunc('day', occurred_at)::date as day,
       coalesce(sum(input_tokens), 0)::bigint as input_tokens,
       coalesce(sum(output_tokens), 0)::bigint as output_tokens,
       coalesce(sum(cached_input_tokens), 0)::bigint as cached_input_tokens
  from bob.turn_metrics
 where occurred_at >= now() - interval '30 days'
 group by 1
 order by 1;
```

### 8. Prompt cache hit ratio per day
Chart: line. The share of input tokens served from the prompt cache each day (0 to 1); higher means cheaper and faster turns.
```sql
select date_trunc('day', occurred_at)::date as day,
       round(sum(cached_input_tokens)::numeric / nullif(sum(input_tokens), 0), 4) as cache_hit_ratio
  from bob.turn_metrics
 where occurred_at >= now() - interval '30 days'
 group by 1
 order by 1;
```

### 9. Top 15 tools (7 days)
Chart: bar. The agent tools called most often, counted by tool name; it shows what people actually use Bob for.
```sql
select tool,
       count(*) as calls
  from (
        select unnest(called_tools) as tool
          from bob.turn_metrics
         where occurred_at >= now() - interval '7 days'
       ) as used
 group by 1
 order by 2 desc
 limit 15;
```

### 10. Intent mix (7 days)
Chart: table. Per intent: turns, success rate (completed divided by completed plus failed) and the p95 total time in milliseconds; a low rate or a high p95 marks the weak spot.
```sql
select intent,
       count(*) as turns,
       round(count(*) filter (where outcome = 'completed')::numeric
             / nullif(count(*) filter (where outcome in ('completed', 'failed')), 0), 4) as success_rate,
       round(percentile_cont(0.95) within group (order by total_ms))::int as p95_total_ms
  from bob.turn_metrics
 where intent is not null
   and occurred_at >= now() - interval '7 days'
 group by 1
 order by 2 desc;
```

### 11. Device fleet by firmware
Chart: bar. Paired devices that are not revoked, counted by firmware version; use it to see how far an update has rolled out.
```sql
select fw_version,
       count(*) as devices
  from bob.devices
 where revoked_at is null
 group by 1
 order by 2 desc;
```

### 12. Outbox backlog now
Chart: number. Notification events still waiting to be delivered, and how many minutes the oldest one has waited; both should sit near zero.
```sql
select count(*) as backlog,
       coalesce(round(extract(epoch from (now() - min(created_at))) / 60), 0)::int as oldest_minutes
  from bob.outbox
 where delivered_at is null;
```

### 13. Reminder funnel (30 days)
Chart: table. Reminders created in the window, then how many occurrences were delivered, acknowledged and snoozed; a big gap between delivered and acknowledged means reminders are being missed.
```sql
select (select count(*)
          from bob.reminders
         where kind = 'reminder'
           and created_at >= now() - interval '30 days') as reminders_created,
       count(*) filter (where delivered_at is not null) as delivered,
       count(*) filter (where acknowledged_at is not null) as acknowledged,
       count(*) filter (where snoozed_until is not null) as snoozed
  from bob.reminder_occurrences
 where occurrence_at >= now() - interval '30 days';
```

### 14. Database size and the 10 largest tables
Chart: table. The whole database first, then the ten biggest `bob` tables with their indexes included; the numbers only ever grow, so watch the rate.
```sql
select 'database total' as item,
       pg_database_size(current_database()) as bytes,
       pg_size_pretty(pg_database_size(current_database())) as size
union all
(select 'bob.' || c.relname,
        pg_total_relation_size(c.oid),
        pg_size_pretty(pg_total_relation_size(c.oid))
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'bob'
    and c.relkind = 'r'
  order by pg_total_relation_size(c.oid) desc
  limit 10);
```

### 15. Approximate rows per table
Chart: table. The 15 `bob` tables with the most rows, from Postgres statistics; the counts are estimates and can lag a little behind.
```sql
select relname as table_name,
       n_live_tup as approx_rows
  from pg_stat_user_tables
 where schemaname = 'bob'
 order by n_live_tup desc
 limit 15;
```

## More database checks with the Supabase CLI

The CLI can inspect the database health that SQL blocks cannot chart well. All of
these are read-only, and they are run by the owner, who has the linked project;
nobody else (and no automated job) should run them against production.

- `npx supabase inspect db cache-hit --linked`: how often reads are served from memory rather than disk.
- `npx supabase inspect db bloat --linked`: tables and indexes carrying dead space that vacuum has not reclaimed.
- `npx supabase inspect db index-usage --linked`: how often each table uses its indexes against scanning the whole table.
- `npx supabase inspect db long-running-queries --linked`: queries that have been running for a long time right now.
- `npx supabase inspect db table-sizes --linked`: the size of each table without its indexes.
- `npx supabase inspect db locks --linked`: sessions holding exclusive locks.
- `npx supabase inspect report --linked`: writes a CSV for every one of these into one folder.

Some of these (`cache-hit`, `index-usage`, `table-sizes`) are marked deprecated
in `npx supabase inspect db --help`; the help also lists `db-stats`,
`index-stats` and `table-stats` as their current counterparts.
