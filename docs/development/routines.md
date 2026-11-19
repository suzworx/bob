# Insights and daily email routines

Bob can create, list, edit, pause, resume and delete a private daily Gmail summary through conversation or the Routines page. Creation requires a selected connected account, local time, IANA time zone and explicit scheduled-read consent. A saved routine reports its next occurrence. The API must be running for execution; the browser can be closed.

## Creating and revisiting routines

The Routines page includes the same conversational composer and message view as the main chat. Ask Bob for a routine, answer follow-up questions, and see the saved routine appear below. The conversation restores when this browser tab reloads; its messages also remain in normal chat history. Unsent routine drafts are separate from main-chat drafts. **New routine** still opens the manual schedule form. Each saved routine exposes **Run history**, and **Insights → Past** holds its prepared summaries. Insights always links back to Routines.

The model-facing creation tool fixes the supported daily Gmail kind internally. It resolves a current Gmail mention first, with fresh authorization checks, without asking for an internal ID. Only without a mention or explicit selector does it use the selected or sole eligible Gmail account. Ambiguous accounts require a choice by email/name; an unavailable mention never falls back to another account. Missing schedule details or scheduled-read consent still require clarification.

Type `@` in the shared composer to find Bob, public feature destinations and people visible in your spaces. Private chat also offers usable connected Gmail and Google Calendar accounts. Shared-space composers do not fetch or suggest private integration accounts. References carry readable names and context; they do not grant access or bypass Core authorization. Selecting Bob preserves the existing assistant invocation token.

Under Integrations, open a connected account's actions and choose **Rename…** to save a private custom name (up to sixty characters). Leave it blank to restore the default. The mention picker searches this name alongside the provider and email. Names survive reconnects, while the stored mention continues to identify the canonical provider and email; existing sent messages keep their provider label.

The picker also offers granted actions as namespaced mentions, such as **WorkGmail.search** or **WorkCalendar.list_events**. Gmail actions are `search`, `read_thread` and `draft_reply`; Calendar actions are `list_calendars`, `list_events`, `create_event` and `update_event`. Select the action and describe its arguments in your message. Selection alone does not send or execute anything. Core restricts offered Google tools and their account resolution to the selected actions; unknown actions fail closed. A namespaced provider action does not authorize creating a scheduled routine: use a bare account mention for that request.

Google tools resolve selected integration mentions from the current persisted private user message against owned accounts. A unique matching mention removes the need for a model-supplied account ID. Explicit email/ID selectors must match any mentioned account; ambiguous, disconnected or foreign accounts never fall back to another account. Every execution still checks fresh grants and private scope.

Insights separates the meaning of a result from execution status:

- **Future:** an explicitly requested seven-day outlook from the selected account's persisted calendar selections. It reports scheduled event-hours and potential overlaps, with assumptions and uncertainty. At most four calendars and forty events per calendar are read; omitted pages are disclosed. No selected calendars means no provider reads and guidance to choose calendars.
- **Reflections:** factual email-volume observations across at least two nonoverlapping saved recap periods, with coverage gaps disclosed. It does not infer productivity, effort or mood.
- **Past:** immutable completed email recaps, with coverage dates, preparation time and source links. Asking Bob for saved insights returns the stored results without regenerating them.

This release supports the bounded daily Gmail-summary routine, rather than arbitrary executable workflows. It never sends or modifies mail. Calendar outlooks and reflections refresh on request; daily scheduling applies to Gmail recaps.

## Time and execution

Schedules retain their selected time zone when the person travels. A spring-forward gap moves to the first valid local instant; a fall-back overlap runs once at the earlier occurrence. Changes take effect from edit time without backfilling the old schedule. After downtime, execution coalesces to the latest due occurrence within twenty-four hours and records missed work; it does not replay a daily backlog.

The first recap covers the preceding twenty-four hours. Later recaps start at the last successful coverage end, capped at seven days with a partial-coverage disclosure. Each occurrence fixes its coverage before fetching so retries use the same interval. Reads are bounded to twenty threads, two hundred messages and a bounded model input. Empty mail is a successful result; unavailable mail is an error. There are at most ten routines per owner and one routine per account/kind/time/zone combination.

The existing transactional outbox hands persisted occurrence references to pg-boss. Run revisions and attempt tokens fence late completions; a result can be published once. Pause, edit, deletion, disconnect and revoked grants prevent stale publication. Consent loss pauses the routine; transient errors receive finite retries. See [queue operation and recovery evidence](routine-jobs.md).

## Private data lifecycle

Routine definitions, run history and insights are owner-scoped behind forced row-level security. Shared conversations receive no routine or saved-insight tools. Provider data is untrusted: background summarization has no tools, and saved-result retrieval marks the conversation for exclusion from automatic memory extraction. Logs and queue payloads contain no mailbox content.

Run history and its results are retained for ninety days; current outlook/reflection snapshots are also pruned after ninety days. Deleting a routine deletes its run history and associated recaps. Disconnecting the Google account or deleting the Bob account removes its routines, insights and queued references. Account export includes run history and source provenance, without internal attempt tokens.

Bob retrieves a bounded page from the hundred most recent saved results: five by default, at most ten, and under ninety kilobytes of serialized tool output. Exact summary text and IDs are preserved. Omitted source references and results are counted, with a continuation offset; full source lists remain available in Insights and account export.

## Evidence

The [reproducible browser demo](routines-demo.md) uses real HTTP, PostgreSQL, scheduler, outbox and queue execution with clearly labeled fictional provider data and a scripted model. It is not proof of live OAuth or model interpretation. Real-account provider verification requires a separately recorded opt-in pilot; hosted connection behavior and sustained foreground voice latency also remain separate deployment checks.
