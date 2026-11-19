/**
 * notify-email: the one door through which the API sends app notification
 * mail. The API names a template and supplies its data; this function builds,
 * renders and sends it. Everything it needs arrives through `deps`, so the
 * contract below is testable without SMTP or Deno.env.
 *
 *   POST { template, to, data }  Authorization: Bearer <NOTIFY_EMAIL_SECRET>
 *   200 {ok:true} | 400 unknown_template / missing_field / bad_request
 *   401 unauthorized | 405 method_not_allowed | 502 send_failed
 */
import type {
  EmailContent,
  EmailTemplate,
  RenderedEmail,
} from "../_shared/email/content.ts";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_ADDRESS_LENGTH = 254;
/**
 * Sent only by send-email (the auth hook) and waitlist. A caller holding this
 * function's secret must not be able to mint a sign-in code email.
 */
const REFUSED_PREFIXES = ["auth-", "security-", "waitlist-"];

export type NotifyDeps = {
  secret: string;
  findTemplate: (
    id: string,
  ) => EmailTemplate<Record<string, unknown>> | undefined;
  render: (content: EmailContent) => RenderedEmail;
  send: (
    message: { to: string; subject: string; html: string; text: string },
  ) => Promise<void>;
  log?: (line: string) => void;
};

function answer(status: number, error?: string): Response {
  const body = error ? { ok: false, error } : { ok: true };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function looksLikeEmail(value: string): boolean {
  return value.length <= MAX_ADDRESS_LENGTH &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFilled(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Compares SHA-256 digests rather than the raw strings, so the loop always
 * runs over 32 bytes and neither length nor content leaks through timing.
 */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

/** A caller-supplied id is logged only when it is shaped like a real one. */
function loggableId(id: unknown): string {
  return typeof id === "string" && /^[a-z0-9-]{1,64}$/.test(id) ? id : "-";
}

export function createHandler(
  deps: NotifyDeps,
): (req: Request) => Promise<Response> {
  const log = deps.log ?? ((line: string): void => console.log(line));
  const outcome = (id: unknown, result: string): void =>
    log(`notify-email template=${loggableId(id)} outcome=${result}`);

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return answer(405, "method_not_allowed");

    const header = req.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!deps.secret || !token || !(await sameSecret(token, deps.secret))) {
      outcome(undefined, "unauthorized");
      return answer(401, "unauthorized");
    }

    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return answer(400, "bad_request");
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength > MAX_BODY_BYTES) return answer(400, "bad_request");

    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return answer(400, "bad_request");
    }
    if (
      !isObject(body) || typeof body.template !== "string" ||
      typeof body.to !== "string" || !looksLikeEmail(body.to) ||
      !isObject(body.data)
    ) {
      outcome(isObject(body) ? body.template : undefined, "bad_request");
      return answer(400, "bad_request");
    }
    const { template: id, to, data } = body;
    // This template has no caller-controlled content or URL.
    if (id === "bob-account-invite" && Object.keys(data).length !== 0) {
      return answer(400, "bad_request");
    }

    const template = REFUSED_PREFIXES.some((p) => id.startsWith(p))
      ? undefined
      : deps.findTemplate(id);
    if (!template) {
      outcome(id, "unknown_template");
      return answer(400, "unknown_template");
    }
    if (!template.required.every((key) => isFilled(data[key]))) {
      outcome(id, "missing_field");
      return answer(400, "missing_field");
    }

    let rendered: RenderedEmail;
    try {
      rendered = deps.render(template.build(data));
    } catch {
      outcome(id, "build_failed");
      return answer(400, "bad_request");
    }

    try {
      await deps.send({ to, ...rendered });
    } catch {
      outcome(id, "send_failed");
      return answer(502, "send_failed");
    }
    outcome(id, "sent");
    return answer(200);
  };
}
