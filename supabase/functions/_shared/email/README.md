# Bob email design system

Every email Bob sends is declared in this directory and rendered by one renderer.

## The model

- **A template is data.** `templates/*.ts` export `EmailTemplate<D>` objects (`content.ts`): an id,
  a category, the trigger that sends it, the data keys it needs, sample data, and
  `build(data) => EmailContent`. `EmailContent` is plain text only: subject, preheader, heading,
  a list of blocks (`paragraph`, `code`, `button`, `details`, `quote`, `note`), the footer
  `reason` and an optional `manageUrl`. Templates never produce HTML.
- **The renderer is HTML.** `renderEmail(content)` in `render.ts` returns `{ subject, html, text }`.
  It escapes every string (hrefs included), and a button whose href is not `https://` or
  `http://localhost` / `http://127.0.0.1` renders as plain text, never a link. Output is
  deterministic.

## The catalog

`catalog.ts` joins every `*_TEMPLATES` array into `TEMPLATES` (33 today) and exports
`findTemplate(id)`, which notify-email uses. At import it runs `assertCatalog`, which throws on a
bad or duplicate id, an unknown category, or a `required` key missing from `sample`.
`catalog.test.ts` also checks that every sample renders, and that notify-email refuses exactly
the auth, security and waitlist categories.

## Static Supabase templates

`supabase/templates/*.html` are Supabase Auth's fallback templates, used only when the Send Email
Hook is off (and locally, in Mailpit). They are generated, so they look identical to the hook's
mail. Never edit them by hand:

    deno run --allow-read --allow-write supabase/functions/_shared/email/build-static.ts          # regenerate
    deno run --allow-read --allow-write supabase/functions/_shared/email/build-static.ts --check  # exit 1 on drift

`build-static.ts` renders each matching catalog template with Supabase's Go-template variables
(`{{ .Token }}`, `{{ .ConfirmationURL }}`, `{{ .NewEmail }}`, `{{ .Email }}`, `{{ .Provider }}`,
`{{ .FactorType }}`) as its data. Each renders as a sentinel that is restored after escaping.
`magic_link.html` is the code email, with no link. Regenerate after changing an auth or security
template.

## Previews

    deno run --allow-read --allow-write supabase/functions/_shared/email/preview.ts [outdir]

This writes one HTML file per template from its sample data, plus `index.html`, a gallery grouped
by category that shows each id, trigger and subject. The default outdir is `.email-preview/`,
which git ignores.

## Adding a template

1. Pick a kebab-case id and add it to the catalog in the right `templates/<category>.ts`.
2. Export its data type and the template as a named const with `satisfies EmailTemplate<XData>`
   (`import type` only), and add it to the file's `*_TEMPLATES` array (`catalog.ts` picks it up;
   update the count in `catalog.test.ts`).
3. Describe the email with blocks; if a block kind is missing, add it to `content.ts` and
   `render.ts` (HTML and text) with a test, not to the template.
4. `sample` uses fictional people (Maya, Arjun) and example.com addresses.

## Email-client constraints

Table layout, inline styles on every element, no `<style>`, no `box-shadow` (Outlook drops it),
no alpha hex (translucent tokens are given as solid composites), max width 560px, light scheme
only (`<meta name="color-scheme" content="light">`), a hidden preheader, `lang="en"`. Manrope and
DM Mono are named but never loaded; the system-font fallbacks must look right on their own. The
button is bulletproof: an ember table cell wrapping an `<a>`, with ink text (white on ember fails
contrast). No Deno globals here: this directory must also import under Node/tsx.

## Tokens

`tokens.ts` mirrors the light values of the web app's Astryx `bob` theme
(`apps/ui-v2/src/app/bob-theme.ts`), and Astryx neutral where `bobTheme` inherits. Each value
names the token it mirrors. `render.test.ts` reads `bob-theme.ts` and fails when
`--color-accent` or `--color-on-accent` changes there until `tokens.ts` follows.
