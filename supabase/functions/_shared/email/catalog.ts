/**
 * The catalog: every email Bob sends, in one list. notify-email looks
 * templates up here, build-static.ts generates the Supabase fallback
 * templates from it, and preview.ts renders a gallery of it.
 * No Deno globals: Node must be able to import this module too.
 */
import type { EmailCategory, EmailTemplate } from "./content.ts";
import { ACCOUNT_TEMPLATES } from "./templates/account.ts";
import { ACTIVITY_TEMPLATES } from "./templates/activity.ts";
import { AUTH_TEMPLATES } from "./templates/auth.ts";
import { CALENDAR_TEMPLATES } from "./templates/calendar.ts";
import { SECURITY_TEMPLATES } from "./templates/security.ts";
import { SPACES_TEMPLATES } from "./templates/spaces.ts";
import { WAITLIST_TEMPLATES } from "./templates/waitlist.ts";

export const CATEGORIES: ReadonlyArray<EmailCategory> = [
  "auth",
  "security",
  "spaces",
  "activity",
  "calendar",
  "account",
  "waitlist",
];

/**
 * `any` because each template takes its own data type, and `build` takes that
 * data as a parameter: EmailTemplate<SignInCodeData> is not assignable to
 * EmailTemplate<unknown> or EmailTemplate<Record<string, unknown>>. Callers
 * validate data against `required` before calling build.
 */
// deno-lint-ignore no-explicit-any
type AnyEmailTemplate = EmailTemplate<any>;

export const TEMPLATES: ReadonlyArray<AnyEmailTemplate> = [
  ...AUTH_TEMPLATES,
  ...SECURITY_TEMPLATES,
  ...SPACES_TEMPLATES,
  ...ACTIVITY_TEMPLATES,
  ...CALENDAR_TEMPLATES,
  ...ACCOUNT_TEMPLATES,
  ...WAITLIST_TEMPLATES,
];

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Throws on the first catalog defect: a bad or duplicate id, an unknown category, or a required key the sample lacks. */
export function assertCatalog(templates: ReadonlyArray<AnyEmailTemplate>): void {
  const seen = new Set<string>();
  for (const t of templates) {
    if (!KEBAB.test(t.id)) throw new Error(`email catalog: id is not kebab-case: ${t.id}`);
    if (seen.has(t.id)) throw new Error(`email catalog: duplicate id: ${t.id}`);
    seen.add(t.id);
    if (!CATEGORIES.includes(t.category)) {
      throw new Error(`email catalog: ${t.id} has unknown category: ${t.category}`);
    }
    for (const key of t.required) {
      if (!(key in t.sample)) throw new Error(`email catalog: ${t.id} sample lacks required key: ${key}`);
    }
  }
}

assertCatalog(TEMPLATES);

const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

export function findTemplate(id: string): AnyEmailTemplate | undefined {
  return BY_ID.get(id);
}
