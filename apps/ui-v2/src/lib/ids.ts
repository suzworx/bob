/**
 * Type-prefixed ids for the ids a web URL carries (IDS epic, 2026-10-06): the
 * web-side twin of apps/api/src/platform/ids.ts, which the web app may not import.
 * `<prefix>_<32 lowercase hex>`; one `conv_` for every conversation. The api's
 * canonicalId also hashes ids with no uuid behind them; a URL must lead back to
 * the stored id, so here those have no prefixed form (null). ids.test.ts holds
 * the shared fixture that keeps the two in step.
 */

const ID_PREFIX = { space: 'spc', conversation: 'conv', device: 'dev' } as const;

export type UrlIdKind = keyof typeof ID_PREFIX;

const LEGACY_PREFIXES: Partial<Record<UrlIdKind, readonly string[]>> = { conversation: ['cnv', 'thr'] };
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function hexOf(kind: UrlIdKind, input: string): string | null {
  const strip = [ID_PREFIX[kind], ...(LEGACY_PREFIXES[kind] ?? [])].find((p) => input.startsWith(`${p}_`));
  const rest = strip === undefined ? input : input.slice(strip.length + 1);
  return UUID.test(rest) ? rest.replaceAll('-', '').toLowerCase() : null;
}

/** The prefixed id for any uuid-backed form of a kind's id, else null. */
export function prefixedId(kind: UrlIdKind, input: string): string | null {
  const hex = hexOf(kind, input);
  return hex === null ? null : `${ID_PREFIX[kind]}_${hex}`;
}

/** The dashed lowercase uuid behind any uuid-backed form of a kind's id, else null. */
export function uuidOf(kind: UrlIdKind, input: string): string | null {
  const hex = hexOf(kind, input);
  if (hex === null) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
