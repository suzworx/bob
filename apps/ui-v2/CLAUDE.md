@AGENTS.md

## Bob additions

### Astryx is the only source of UI. No custom changes.

This is the hard rule for `apps/ui-v2`, and it overrides any instinct to hand-write markup,
spacing or styling. If a screen seems to need something bespoke, the answer is an Astryx template,
component or pattern you have not found yet — go and find it.

Consult these every time, before writing a line:

- https://astryx.atmeta.com/templates — scaffold from the closest template **and keep its spacing**
- https://astryx.atmeta.com/components — read the props before using a component
- https://astryx.atmeta.com/docs/getting-started
- https://astryx.atmeta.com/docs/cli
- https://astryx.atmeta.com/docs/working-with-ai#overview — read this one FIRST; it is written
  for you, not for a human
- Astryx **design patterns** and **UX patterns** — not just the component list. The pattern tells
  you which components go together and how; the component page only tells you what props exist.

### One chat surface. One composer. Configuration, not new components.

Every chat in this app uses the SAME composer and the SAME conversation view. The main chat and a
space thread are one interface — the only thing that varies is **how many actors are in the room**.
Never build a second composer or a second message list because a surface "is different".

**Make components configuration-driven rather than creating new ones.** When a new scenario does
not fit an existing component, add a prop or a config option to that component so both callers
share it. Do not fork it, do not wrap it in a near-duplicate, and do not create a parallel
component with a different name. *Every new component is a new component to maintain* — that cost
is paid forever, by everyone, while a prop is paid once.

If an existing component is genuinely incompatible, **change the component**. Use the Astryx CLI
and the design-system skills to shape it properly rather than hand-rolling a variant.

This was written after the two surfaces were compared side by side on a phone and found to be
different products. Measured here on 2026-09-22:

| capability | main chat | thread |
| --- | --- | --- |
| markdown rendering | 3 refs | 0 |
| composer toolbar (attach / @ / voice) | 7 refs | 0 |
| streaming, reasoning, tool calls | yes | none |

The thread's composer placeholder read "press @ for people" while having no @ button, and its
`@`-mention did not reach the posted body. Each of those is a capability built once and then not
shared: the cost of a second implementation, paid twice and diverging.

Payload types may legitimately differ (`UIMessage` carries streaming parts and versions;
`ThreadMessage` carries revisions and tombstones). Share the shell and the composer; let each
caller map its own rows. Do not force a union type to prove a point.

### DRY / KISS / YAGNI

Do not repeat a pattern Astryx already has; do not build the clever version; do not build the
thing nobody asked for. One create-space form, not two. One date formatter, not eighteen. If two
screens need the same block, they use the same Astryx block.

### The 3-step workflow, from `docs/working-with-ai`

Astryx's own AI guidance says to do these three, in order, **before writing any UI code**:

1. `astryx template --list` — find a related page pattern to use as reference
2. `astryx template <name> --skeleton` — study the layout structure
3. `astryx component <Name>` — read props and examples for **every** component used

Skipping step 1 and 2 and going straight to components is what produced the 2026-09-22 defects
below. Add `--dense` to any command for a token-efficient output.

### Check yourself before writing Astryx code

From `docs/working-with-ai`: these have "a 0% pass rate without docs; models confidently guess
wrong on all of them".

1. What is the correct import path for Button?
2. How do you make a Dialog non-dismissible?
3. What prop does Selector use for its items?

Answers, verified with the CLI on 2026-09-22: `@astryxdesign/core/Button`; `purpose="required"`
(NOT an invented `isDismissible`); `options`. An agent asked these cold that day got #2 wrong and
only knew #1 and #3 from reading this repo. If you cannot answer all three, you do not know Astryx
— read the CLI, do not guess a prop.

Then work through the CLI, from `apps/ui-v2`:

```
npx astryx build "<idea>"            # START HERE: names the closest page template + blocks
npx astryx template <name> [--skeleton]
npx astryx component <Name>
npx astryx docs layout               # BEFORE any frame or padding decision
npx astryx docs spacing
npx astryx search "<thing>"          # when you think nothing fits, before hand-rolling
```

`npm run astryx -- <cmd>` works too; add `--dense`. Astryx is pinned at 0.6.2 — the CLI serves docs
for exactly that version, the MCP serves the latest, so **the CLI wins** when they disagree.

### Why this is a hard rule, not a preference

The 2026-09-22 Spaces redesign was built from Astryx components while skipping the templates and
the layout docs. It shipped with:

- **zero page padding** — the title flush against the rail, because the `messaging-shell` template's
  own `paddingInline: var(--spacing-3)` values were dropped when its structure was copied
- a **month calendar stretched across 1150px**, while `docs layout` says lists and forms
  "cap with Layout contentWidth so lines never over-stretch"
- **five different gutters across seven pages**, because every page hand-composed its own frame
- a **Section painting over the Account page's email**, because that page hand-built a title block
  as a bare `VStack` above full-bleed Sections, instead of scaffolding `astryx template settings`
  (whose title lives in a `LayoutHeader`) and following the `SectionWithDividers` block, where
  every sibling in the stack is a `Section`

The owner's verdict: "the demo and reality are a lot different ... its terrible ux".

### One frame: `PAGE_WIDTH`, and two `padding={0}` traps

Every page and every conversation sits in `Layout contentWidth={PAGE_WIDTH}` (`src/app/page-width.ts`)
with the same outer padding, so titles, tab content and the composer share one left edge and
nothing jumps sideways between pages. Never introduce a second width number.

Both of these were found on 2026-09-22 by measuring a desktop page, not by any test:

- **`<LayoutContent padding={0}>` is full bleed.** In `@astryxdesign/core` `LayoutContent.js`,
  `padding === 0` applies `fullBleed`, which **skips the `contentWidth` alignment** — the header
  stays capped while the content spans the pane (the Spaces tabs stretched to 1500px this way).
- **A nested `Section` with `padding={0}` lands outside the gutter.** `Section.js` escapes its
  parent container's padding with negative margins and re-applies only ITS OWN padding. With
  `padding={0}` it re-applies nothing, so the content sits one gutter left of the title (24px).

### Gates must be positive

A grep for `className` / `style={{}}` / hex / px is a **negative** gate: it proves no raw CSS was
written. It cannot prove a padding prop was **set**, so zero padding passes it cleanly. That gate
shipped all of the above while reporting green.

Gate on the rendered result instead — assert the page gutter is non-zero and equal to its siblings —
and **look at the rendered page** before calling any UI change done.

### Still true

- Stricter than the block above: no `className`, no `style={{}}`, and no CSS files of our own
  beyond `src/base.css`. Use only real theme tokens.
- Icons: lucide-react components through Astryx `<Icon icon={...} size="sm|md">`. Reach for the
  semantic names first (`close`, `check`, `search`, `copy`, `microphone`, `chevronLeft` ...) and
  never pass a numeric size. The app-wide stroke comes from `<LucideProvider strokeWidth={1.5}>`
  in `app.tsx`.
- Never run `astryx swizzle` in this repo — it writes component copies, which is a custom change by
  another name.
- Code is grouped by feature in `src/features/<name>/` (each keeps its `*-api.ts` client, hooks, components and tests together), the shell, routes and theme are in `src/app/`, and auth plus the truly shared hooks are in `src/lib/`. Import all of them through the `@/` alias, e.g. `@/lib/auth/use-session`, `@/features/spaces/use-spaces`.
