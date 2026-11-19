import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import type { Block, EmailContent } from "./content.ts";
import { escapeHtml, renderEmail } from "./render.ts";
import { ACCENT, ON_ACCENT } from "./tokens.ts";

const EVIL = `<script>alert("x")</script>'q'`;

const BASE: EmailContent = {
  subject: "Your Bob code",
  preheader: "Use 123456 to sign in",
  heading: "Sign in to Bob",
  blocks: [
    { kind: "paragraph", text: "Hi Maya, here is your code." },
    { kind: "code", value: "123456" },
    { kind: "button", href: "https://app.heybob.xyz/spaces/1", label: "Open space" },
  ],
  reason: "You asked to sign in to Bob.",
};

const EVERY_KIND: Block[] = [
  { kind: "paragraph", text: EVIL },
  { kind: "code", value: EVIL },
  { kind: "button", href: `https://example.com/?a="b"&c=<d>`, label: EVIL },
  { kind: "details", rows: [{ label: EVIL, value: EVIL }] },
  { kind: "quote", text: EVIL },
  { kind: "note", text: EVIL },
];

Deno.test("escapeHtml escapes markup and both quote kinds", () => {
  assertEquals(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
});

for (const block of EVERY_KIND) {
  Deno.test(`every string in a ${block.kind} block is escaped`, () => {
    const { html } = renderEmail({ ...BASE, blocks: [block] });
    assert(!html.includes("<script>"), "raw <script> in html");
    assert(!html.includes(`"x"`), "raw double quotes from content in html");
    assert(!html.includes(`'q'`), "raw single quotes from content in html");
    assertStringIncludes(html, "&lt;script&gt;");
  });
}

Deno.test("subject, preheader, heading, reason and manageUrl are escaped", () => {
  const { html } = renderEmail({
    ...BASE,
    subject: EVIL,
    preheader: EVIL,
    heading: EVIL,
    reason: EVIL,
    manageUrl: `https://example.com/"><script>`,
  });
  assert(!html.includes("<script>"));
  assert(!html.includes(`"x"`));
});

Deno.test("an unsafe button href never becomes an href", () => {
  for (const href of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "http://evil.example.com", "http://localhost.evil.com/", "data:text/html,hi"]) {
    const { html } = renderEmail({ ...BASE, blocks: [{ kind: "button", href, label: "Go" }] });
    assert(!html.toLowerCase().includes("javascript:alert(1)\""), href);
    assert(!/href="(?!https:\/\/)/i.test(html), `non-https href rendered for ${href}`);
  }
});

Deno.test("local dev hosts may be links", () => {
  for (const href of ["http://localhost:5173/x", "http://127.0.0.1:54321/y"]) {
    const { html } = renderEmail({ ...BASE, blocks: [{ kind: "button", href, label: "Go" }] });
    assertStringIncludes(html, `href="${href}"`);
  }
});

Deno.test("preheader is present and hidden", () => {
  const { html } = renderEmail(BASE);
  const match = html.match(/<div style="([^"]*)">Use 123456 to sign in<\/div>/);
  assert(match, "preheader div missing");
  assertStringIncludes(match[1], "display:none");
});

Deno.test("button is Bob ink with white text", () => {
  const { html } = renderEmail(BASE);
  assertEquals(ACCENT, "#173e57");
  assertEquals(ON_ACCENT, "#ffffff");
  assertStringIncludes(html, `bgcolor="${ACCENT}" style="background-color:${ACCENT};border-radius:999px;"`);
  const link = html.match(/<a href="https:\/\/app\.heybob\.xyz\/spaces\/1"[^>]*style="([^"]*)"/);
  assert(link, "button link missing");
  assertStringIncludes(link[1], `color:${ON_ACCENT};`);
});

Deno.test("manageUrl renders only when set", () => {
  assert(!renderEmail(BASE).html.includes("Notification settings"));
  assert(!renderEmail(BASE).text.includes("Notification settings"));
  const set = renderEmail({ ...BASE, manageUrl: "https://app.heybob.xyz/settings/notifications" });
  assertStringIncludes(set.html, `href="https://app.heybob.xyz/settings/notifications"`);
  assertStringIncludes(set.html, "Notification settings");
  assertStringIncludes(set.text, "Notification settings: https://app.heybob.xyz/settings/notifications");
});

Deno.test("details has a fixed label column, so every email lines up the same", () => {
  const { html } = renderEmail({
    ...BASE,
    blocks: [{
      kind: "details",
      rows: [{ label: "Task", value: "A very long task title that has to wrap" }, { label: "Due", value: "Friday" }],
    }],
  });
  const table = html.match(/<table [^>]*table-layout:fixed;[^>]*>/);
  assert(table, "details table is not fixed-layout");
  assertStringIncludes(table[0], `width="100%"`);
  const labels = [...html.matchAll(/<td width="120" valign="top" style="([^"]*)">(Task|Due)<\/td><td [^>]*style="([^"]*)"/g)];
  assertEquals(labels.length, 2);
  for (const [, labelStyle, , valueStyle] of labels) {
    assertStringIncludes(labelStyle, "width:120px;");
    assertStringIncludes(valueStyle, "word-break:break-word;");
    assert(!valueStyle.includes("width"), "value cell must take the remaining width");
  }
});

Deno.test("text output carries the heading, code, hrefs, details and reason in order", () => {
  const { text } = renderEmail({
    ...BASE,
    blocks: [...BASE.blocks, { kind: "details", rows: [{ label: "Space", value: "Home" }] }],
  });
  const order = ["Sign in to Bob", "Hi Maya", "\n123456\n", "Open space: https://app.heybob.xyz/spaces/1", "Space: Home", "You asked to sign in"];
  let at = -1;
  for (const piece of order) {
    const next = text.indexOf(piece);
    assert(next > at, `"${piece}" missing or out of order`);
    at = next;
  }
});

Deno.test("html is email-client safe", () => {
  const { html } = renderEmail({ ...BASE, blocks: EVERY_KIND });
  assert(!html.includes("box-shadow"));
  assert(!html.includes("<style"));
  assertStringIncludes(html, `<meta name="color-scheme" content="light">`);
  assertStringIncludes(html, `lang="en"`);
  assertStringIncludes(html, "max-width:560px");
});

Deno.test("output is deterministic", () => {
  assertEquals(renderEmail(BASE), renderEmail(BASE));
});

Deno.test("accent and on-accent match bob-theme.ts light values", async () => {
  const theme = await Deno.readTextFile(new URL("../../../../apps/ui-v2/src/app/bob-theme.ts", import.meta.url));
  const light = (token: string): string | undefined =>
    theme.match(new RegExp(`'${token}':\\s*\\['(#[0-9a-fA-F]+)'`))?.[1];
  assertEquals(light("--color-accent"), ACCENT);
  assertEquals(light("--color-on-accent"), ON_ACCENT);
});
