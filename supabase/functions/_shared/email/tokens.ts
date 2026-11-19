/**
 * The email palette and fonts, mirrored from the web app's Astryx `bob`
 * theme (apps/ui-v2/src/app/bob-theme.ts). Emails are light-only, so every
 * value is the theme's LIGHT value. render.test.ts reads bob-theme.ts and
 * fails when the accent or on-accent value here drifts from it.
 *
 * Email clients (Outlook, older Gmail) drop 8-digit hex, so a translucent
 * theme colour is also given as its solid composite over the card surface.
 */

// --color-accent (bobTheme, light): Bob ink.
export const ACCENT = "#173e57";

// --color-on-accent (bobTheme, light): white on ink, 11.6:1.
export const ON_ACCENT = "#ffffff";

// --color-accent-muted (bobTheme, light), as declared.
const ACCENT_MUTED = "#173e571f";

// --color-accent-muted, composited over SURFACE (#ffffff) for clients without alpha hex.
export const ACCENT_MUTED_SOLID = "#e3e8eb";

// --color-text-accent (bobTheme, light): Bob ink for accent text and links.
export const TEXT_ACCENT = "#173e57";

// --color-background-body (neutral, light; inherited by bobTheme).
export const BACKGROUND_BODY = "#f5f5f5";

// --color-background-card (neutral, light; inherited by bobTheme).
export const SURFACE = "#ffffff";

// --color-border (neutral, light; inherited by bobTheme).
export const BORDER = "#e5e5e5";

// --color-text-primary (fallback: bob-paper's ink; neutral's light value was not readable).
export const TEXT_PRIMARY = "#1c2924";

// --color-text-secondary (fallback: bob-paper's ink; neutral's light value was not readable).
export const TEXT_SECONDARY = "#46534d";

// typography.body / typography.heading (bobTheme): Nunito, with web-safe fallbacks.
export const FONT_BODY =
  "Nunito, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// typography.code (bobTheme): DM Mono, with web-safe fallbacks.
export const FONT_CODE =
  "'DM Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace";

/** Every token in one object, for callers that want them together. */
const EMAIL_TOKENS = {
  accent: ACCENT,
  onAccent: ON_ACCENT,
  accentMuted: ACCENT_MUTED,
  accentMutedSolid: ACCENT_MUTED_SOLID,
  textAccent: TEXT_ACCENT,
  backgroundBody: BACKGROUND_BODY,
  surface: SURFACE,
  border: BORDER,
  textPrimary: TEXT_PRIMARY,
  textSecondary: TEXT_SECONDARY,
  fontBody: FONT_BODY,
  fontCode: FONT_CODE,
} as const;
