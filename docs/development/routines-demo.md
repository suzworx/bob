# Routines, timeline and tools: local working demo

This demo uses fictional email and calendar records and a deterministic synthetic model. It requires the repository's local PostgreSQL test instance and installed Node dependencies; it never connects to Gmail or an AI provider.

The HTTP routes, account authorization, routine tools, Postgres stores, outbox, pg-boss worker, digest validation, independent routine results, scoped tool preferences, and React application are real. The harness creates a disposable migrated database and drops it when it exits. It binds the API to loopback port 7488 and the UI to loopback port 5188.

From the repository root:

```powershell
npx playwright test --config apps/ui-v2/playwright.routines-demo.config.ts
```

The dedicated Playwright configuration starts the synthetic API and UI. The test opens the optional Ask Bob conversation, creates a daily routine, closes the browser page, waits for its real scheduled execution and reopens the routine's Timeline tab. It checks readable Markdown headings and verified source links, then changes the name, Gmail filter, instructions, summary detail, weekdays and timezone in Configuration. The daily Timeline must show the actual run, a conversation and a task; routine results must stay out of the Insights list.

A second desktop/mobile flow renames the integration, selects its namespaced Gmail search, and verifies successful real tool execution against the synthetic provider. It then disables and re-enables Gmail search at integration and conversation scope through the Tools UI, checks settings survive reload, and proves disabled operations are refused by the real policy/tool boundary. The tests never intercept API responses. Desktop and mobile run sequentially. The harness raises only its own API rate limit for repeated navigation and polls the queue result every five seconds. Servers are always started fresh; occupied ports cause the run to fail.

Screenshots, videos, the HTML report, and nonsecret evidence JSON are written under `data/routines-demo/` (ignored by Git). Tests make real HTTP requests and do not intercept API results. The synthetic model handles only the exact demo sentences, so this checks tool integration rather than general language understanding. Two historical summaries are prepared through the real queue before startup. Provider/model data remain synthetic; the harness also creates one real task for the daily timeline.

To explore interactively, run `npx tsx scripts/demo-routines.ts`, then start Vite with the same ports and the e2e Vite config. Use the local development sign-in and this sentence, replacing the time with a future UTC minute:

> Demo: create my daily email summary at 08:00 UTC using morning@example.test. I authorize scheduled email reads.

To retrieve the existing result, ask: `Demo: show my saved email summaries.`

## On-page conversation and mentions follow-up (#1282)

The demo now starts on Routines. It searches and selects Bob, Gmail and Routines through `@`, asks for help, reloads the saved clarification, and submits the account/time/consent reply without leaving the page. The real SDK tool call supplies no internal routine-kind value. The routine appears below the conversation, and **Run history** opens the completed result after the browser-closed execution.

Desktop, mobile and supplemental dark checks passed: **3 passed, 1 intentional mobile dark skip (3.9 minutes)**. Provider/model data remain synthetic; HTTP, conversation persistence, tool authorization, queue execution and saved results are real.

- [Desktop composer](../demos/routines/composer-desktop.png) and [mobile composer](../demos/routines/composer-mobile.png)
- Desktop videos: [mentions and two-turn setup](../demos/routines/composer-desktop.webm), [saved results and history](../demos/routines/composer-desktop-results.webm)
- Mobile videos: [mentions and two-turn setup](../demos/routines/composer-mobile.webm), [saved results and history](../demos/routines/composer-mobile-results.webm)

Use Ctrl+C to stop the harness and release its disposable database. Do not run it against production; the harness rejects production mode and non-loopback database locations.



## Recorded evidence

### Named integration mentions (#1286)

Run `npx playwright test --config apps/ui-v2/playwright.routines-demo.config.ts --grep "custom integration"` for the focused rename-to-search flow: rename the account to WorkGmail, reload, select `@WorkGmail.search`, and execute the real Google search tool with no account ID supplied by the scripted model. The fictional provider asserts the resolved owner and account before returning its result. The test does not intercept HTTP responses. The namespaced flow passed on desktop and mobile (2/2, 23 seconds).

- [Mobile integration name](../demos/integrations/mobile-name.png)
- [Mobile mention](../demos/integrations/mobile-mention.png)
- [Desktop mention](../demos/integrations/desktop-mention.png)

This verifies account resolution and UI persistence, not live Google access or general model interpretation. The model and mail content remain explicitly synthetic.

On 2026-10-22, both full browser flows passed: **2 passed (4.4 minutes)**, at 1280×900 desktop and 390×844 mobile. The page was closed before the due time and a new page opened after completion; [sanitized timing evidence](../demos/routines/evidence.json) records those timestamps. There is no before image because Insights and Routines routes did not previously exist.

- [Bob creates the routine](../demos/routines/desktop-bob-creation.png)
- [Saved Past summary](../demos/routines/desktop-past.png)
- [Future calendar outlook](../demos/routines/desktop-future.png)
- [Reflections from saved periods](../demos/routines/desktop-reflections.png)
- [Mobile scheduled routine](../demos/routines/mobile-scheduled.png) and [mobile saved summary](../demos/routines/mobile-past.png)
- Desktop videos: [creation](../demos/routines/desktop-create.webm), [saved results, management, and retrieval](../demos/routines/desktop-results.webm)
- Mobile videos: [creation](../demos/routines/mobile-create.webm), [saved results, management, and retrieval](../demos/routines/mobile-results.webm)

Videos are separate before-close and after-reopen segments because no browser page is open while the scheduled worker executes. All displayed accounts and messages are synthetic. The retrieval model deliberately includes stored identifiers in its demo response so the test can verify exact result reuse; this is not production reply formatting.

Supplemental dark-theme browser check: **1 passed (17.0 seconds)**, using the same real seeded queue history. [Dark Past screenshot](../demos/routines/desktop-past-dark.png).
