/**
 * The one renderer every Bob email goes through: EmailContent in,
 * { subject, html, text } out. Email-client-safe by construction: tables for
 * layout, inline styles on every element, no <style>, no box-shadow, and
 * system-font fallbacks that look right when Nunito and DM Mono are absent.
 * Deterministic: the same content always renders the same bytes.
 */
import type { Block, EmailContent, RenderedEmail } from "./content.ts";
import {
  ACCENT,
  ACCENT_MUTED_SOLID,
  BACKGROUND_BODY,
  BORDER,
  FONT_BODY,
  FONT_CODE,
  ON_ACCENT,
  SURFACE,
  TEXT_ACCENT,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
} from "./tokens.ts";

/** Escape text for HTML element content and double- or single-quoted attributes. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only https, or http to a local dev host, may become a link. */
function isSafeHref(href: string): boolean {
  return /^https:\/\/[^\s]+$/i.test(href) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?([/?#][^\s]*)?$/i.test(href);
}

const TEXT = `font-family:${FONT_BODY};margin:0;`;
const PARAGRAPH =
  `${TEXT}font-size:16px;line-height:1.5;color:${TEXT_SECONDARY};`;
const SMALL = `${TEXT}font-size:14px;line-height:1.5;color:${TEXT_SECONDARY};`;
const LINK = `color:${TEXT_ACCENT};text-decoration:underline;`;

/** A full-width row of the card, spaced from the block above it. */
function row(inner: string): string {
  return `<tr><td style="padding:16px 0 0 0;">${inner}</td></tr>`;
}

function renderBlock(block: Block): string {
  switch (block.kind) {
    case "paragraph":
      return row(`<p style="${PARAGRAPH}">${escapeHtml(block.text)}</p>`);
    case "code":
      return row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td align="center" style="background-color:${ACCENT_MUTED_SOLID};border:1px solid ${ACCENT};border-radius:12px;padding:16px 12px;font-family:${FONT_CODE};font-size:30px;line-height:1.2;letter-spacing:6px;font-weight:500;color:${TEXT_PRIMARY};text-align:center;">${
          escapeHtml(block.value)
        }</td></tr></table>`,
      );
    case "button": {
      if (!isSafeHref(block.href)) {
        return row(
          `<p style="${PARAGRAPH}">${escapeHtml(block.label)}: ${
            escapeHtml(block.href)
          }</p>`,
        );
      }
      const href = escapeHtml(block.href);
      return row(
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td align="center" bgcolor="${ACCENT}" style="background-color:${ACCENT};border-radius:999px;"><a href="${href}" target="_blank" style="display:inline-block;padding:12px 28px;font-family:${FONT_BODY};font-size:16px;line-height:1.25;font-weight:700;color:${ON_ACCENT};text-decoration:none;border-radius:999px;">${
          escapeHtml(block.label)
        }</a></td></tr></table>`,
      );
    }
    // A fixed label column, so values line up at the same x in every email;
    // clients otherwise size the columns from each email's content.
    case "details":
      return row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;">${
          block.rows.map((r) =>
            `<tr><td width="120" valign="top" style="${SMALL}width:120px;vertical-align:top;padding:4px 16px 4px 0;">${
              escapeHtml(r.label)
            }</td><td valign="top" style="${TEXT}font-size:14px;line-height:1.5;color:${TEXT_PRIMARY};vertical-align:top;padding:4px 0;word-break:break-word;overflow-wrap:anywhere;">${
              escapeHtml(r.value)
            }</td></tr>`
          ).join("")
        }</table>`,
      );
    case "quote":
      return row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-left:3px solid ${ACCENT};padding:4px 0 4px 16px;"><p style="${PARAGRAPH}font-style:normal;">${
          escapeHtml(block.text)
        }</p></td></tr></table>`,
      );
    case "note":
      return row(`<p style="${SMALL}">${escapeHtml(block.text)}</p>`);
  }
}

function blockText(block: Block): string {
  switch (block.kind) {
    case "paragraph":
    case "quote":
    case "note":
      return block.text;
    case "code":
      return block.value;
    case "button":
      return `${block.label}: ${block.href}`;
    case "details":
      return block.rows.map((r) => `${r.label}: ${r.value}`).join("\n");
  }
}

/** Turn content into the subject, the HTML body and a plain-text alternative. */
export function renderEmail(content: EmailContent): RenderedEmail {
  const brand = "Bob";
  const footer = "Bob \u00b7 www.heybob.xyz";
  const manage = content.manageUrl;
  const manageHtml = manage === undefined ? "" : isSafeHref(manage)
    ? `<p style="${SMALL}padding-top:8px;"><a href="${
      escapeHtml(manage)
    }" target="_blank" style="${LINK}">Notification settings</a></p>`
    : `<p style="${SMALL}padding-top:8px;">Notification settings: ${
      escapeHtml(manage)
    }</p>`;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${
    escapeHtml(content.subject)
  }</title></head>
<body style="margin:0;padding:0;background-color:${BACKGROUND_BODY};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${BACKGROUND_BODY};">${
    escapeHtml(content.preheader)
  }</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BACKGROUND_BODY}" style="background-color:${BACKGROUND_BODY};"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">
<tr><td style="padding:0 4px 16px 4px;"><p style="${TEXT}font-size:22px;line-height:1.2;font-weight:800;letter-spacing:-0.5px;color:${TEXT_PRIMARY};">${brand}</p></td></tr>
<tr><td bgcolor="${SURFACE}" style="background-color:${SURFACE};border:1px solid ${BORDER};border-radius:16px;padding:32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td><h1 style="${TEXT}font-size:24px;line-height:1.3;font-weight:700;color:${TEXT_PRIMARY};">${
    escapeHtml(content.heading)
  }</h1></td></tr>
${content.blocks.map(renderBlock).join("\n")}
</table></td></tr>
<tr><td style="padding:24px 4px 0 4px;"><p style="${SMALL}">${
    escapeHtml(content.reason)
  }</p>${manageHtml}<p style="${SMALL}padding-top:8px;">${footer}</p></td></tr>
</table></td></tr></table>
</body></html>
`;

  const text = [
    content.heading,
    ...content.blocks.map(blockText),
    content.reason,
    ...(manage === undefined ? [] : [`Notification settings: ${manage}`]),
    footer,
  ].join("\n\n") + "\n";

  return { subject: content.subject, html, text };
}
