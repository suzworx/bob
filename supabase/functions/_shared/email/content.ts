/**
 * The email design system's data model. A template turns its data into an
 * EmailContent; render.ts turns EmailContent into HTML and plain text.
 * Types only: no runtime code, so any module can `import type` it.
 */

/** One piece of an email body. All strings are PLAIN TEXT; render.ts escapes them. */
export type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "code"; value: string } // the one-time-code chip
  | { kind: "button"; href: string; label: string } // one primary action
  | { kind: "details"; rows: ReadonlyArray<{ label: string; value: string }> }
  | { kind: "quote"; text: string } // short excerpt, e.g. a mention
  | { kind: "note"; text: string }; // small print

/** Everything an email says, with no markup. */
export type EmailContent = {
  subject: string;
  /** Inbox preview line, hidden in the body. */
  preheader: string;
  heading: string;
  blocks: ReadonlyArray<Block>;
  /** Footer line: why this person got this email. */
  reason: string;
  /** Notification emails: link to notification settings. */
  manageUrl?: string;
};

/** The catalog's grouping; notify-email refuses auth, security and waitlist. */
export type EmailCategory =
  | "auth"
  | "security"
  | "spaces"
  | "activity"
  | "calendar"
  | "account"
  | "waitlist";

/** One email Bob sends: its id, what sends it, and how its data becomes content. */
export type EmailTemplate<D> = {
  id: string; // kebab-case, globally unique, from the catalog
  category: EmailCategory;
  /** One line: the user action / system event that sends it. */
  trigger: string;
  /** Keys of D a caller must supply (validated by notify-email). */
  required: ReadonlyArray<keyof D & string>;
  build: (data: D) => EmailContent;
  /** Realistic preview data. Fictional people only (Maya, Arjun), example.com addresses. */
  sample: D;
};

/** renderEmail's output, ready for sendMail. */
export type RenderedEmail = { subject: string; html: string; text: string };
