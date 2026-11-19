# Routines, Timeline and tool preferences

Routines own their scheduled runs and saved results. Insights remains a separate place for forecasts and reflections. Reflections can use routine results as evidence without moving those results into Insights.

## Routines

The Routines page lists current routines and has an Archived view. A routine opens to Overview, Timeline and Configuration. Its timeline groups executions by day and expands each run into its saved recap, coverage, status and named sources. Archiving stops future runs and keeps read-only history accessible. Existing run retention remains 90 days; disconnecting an integration or erasing the account removes its dependent results.

Email recaps support a name, Google account, Gmail query, focus instructions, weekdays, local time, IANA timezone and concise or detailed output. Changing accounts requires renewed scheduled-read consent. Historical results keep the source account used at execution. Updates use revisions; stale editors cannot overwrite a newer configuration.

Migration `20261023070000_routine_timeline.sql` copies existing run-backed Insights into the new routine results table, preserving result IDs. New runs write only to routine results. Existing Insights rows remain stored but are excluded from the Insights list when tied to a run.

## Daily Timeline

The Timeline page combines routine executions, conversations and productivity activity for a selected local day. It offers source links, activity filters, cursor pagination and an optional conversation with Bob about that day.

Activity comes from retained records under their existing RLS policies. Conversations are grouped by day; tasks show creation and current completion timestamps; notes show creation and their latest update; calendar events show creation. This is not an immutable audit trail. Deleted records and revoked shared-space access are not reconstructed. Day boundaries use the selected timezone, including daylight-saving transitions.

`GET /api/timeline` accepts `day`, `timeZone`, optional `kind` and a paired `before`/`beforeId` cursor. `list_timeline` rechecks the private conversation before reading. Game restrictions still apply.

## Tools

Tools lists built-in productivity, memory, games, device and connected-provider capabilities. Account, integration, space and conversation settings can disable individual tools or reset a local preference to inheritance. Integration rows expose their tools; chat and space headers link to the appropriate scope.

A denial at any applicable scope wins. Enabling a child setting cannot override a parent denial, grant OAuth permissions, expose a private integration in a shared conversation, or bypass existing turn restrictions. Space owners/admins and conversation owners manage the applicable shared settings. Account and integration preferences remain owner-only.

The agent factory filters the final merged tool map. Captured executions recheck preferences, including integration account resolution. Missing policy storage fails closed. Device turns intersect the conversation policy with the actual target space when their active space differs. Scheduled Gmail reads check account and integration preferences before reads and publication.

`GET /api/tools` returns the catalog and effective settings for its context. `PATCH /api/tools/preferences` accepts `scope`, optional `scopeId`, `toolId`, and `enabled`; `null` removes the local override. Migration `20261023080000_tool_preferences.sql` stores these preferences with RLS and entity foreign keys. Account export includes owned preferences; account erasure explicitly removes them even when the authentication identity is retained.

Use the [synthetic browser demo](routines-demo.md) for the real HTTP, database and queue flow without accessing Google or an AI provider. Software validation is `npm run validate -- --skip-firmware`.

On 2026-10-23 the dedicated desktop/mobile browser suite passed all four flows in 4.6 minutes: closed-page scheduled execution, saved configuration and results, daily activity, and integration/conversation disable–deny–reenable. Provider/model data were synthetic; HTTP, Postgres, queue and policy execution were real.
