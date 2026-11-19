/**
 * Renders every catalog template from its sample data into a folder you can
 * open in a browser: one <id>.html per template plus index.html, a gallery
 * grouped by category showing each id, trigger, subject and the email itself.
 *
 *   deno run --allow-read --allow-write supabase/functions/_shared/email/preview.ts [outdir]
 *
 * outdir defaults to .email-preview/ (git-ignored).
 */
import { CATEGORIES, TEMPLATES } from "./catalog.ts";
import { escapeHtml, renderEmail } from "./render.ts";

/** Every preview file as [file name, contents]. */
export function buildPreview(): Array<[string, string]> {
  const files: Array<[string, string]> = [];
  const sections: string[] = [];
  for (const category of CATEGORIES) {
    const cards = TEMPLATES.filter((t) => t.category === category).map((t) => {
      const rendered = renderEmail(t.build(t.sample));
      files.push([`${t.id}.html`, rendered.html]);
      return `<article style="margin:0 0 32px 0;">
<h3 style="margin:0 0 4px 0;font:600 16px/1.4 ui-monospace,Menlo,monospace;">${escapeHtml(t.id)}</h3>
<p style="margin:0;color:#555;">Trigger: ${escapeHtml(t.trigger)}</p>
<p style="margin:0 0 8px 0;color:#555;">Subject: ${escapeHtml(rendered.subject)}</p>
<iframe src="${escapeHtml(t.id)}.html" title="${escapeHtml(t.id)}" loading="lazy" style="width:100%;max-width:640px;height:640px;border:1px solid #ddd;border-radius:8px;"></iframe>
</article>`;
    });
    if (cards.length === 0) continue;
    sections.push(`<section><h2 style="margin:40px 0 16px 0;text-transform:capitalize;">${category} (${cards.length})</h2>\n${cards.join("\n")}</section>`);
  }
  const index = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bob emails</title></head>
<body style="margin:0 auto;padding:24px 16px;max-width:720px;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1c1c;">
<h1 style="margin:0;">Bob emails</h1>
<p style="margin:4px 0 0 0;color:#555;">${TEMPLATES.length} templates, rendered from sample data.</p>
${sections.join("\n")}
</body></html>
`;
  files.push(["index.html", index]);
  return files;
}

async function main(): Promise<void> {
  const outdir = (Deno.args[0] ?? ".email-preview").replace(/\/+$/, "");
  await Deno.mkdir(outdir, { recursive: true });
  const files = buildPreview();
  for (const [name, html] of files) await Deno.writeTextFile(`${outdir}/${name}`, html);
  console.log(`wrote ${files.length} files to ${outdir}/ — open ${outdir}/index.html`);
}

if (import.meta.main) await main();
