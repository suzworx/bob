/**
 * Public waitlist: request a code, then verify it.
 *
 * This exists instead of Supabase Auth's email OTP because that route needs
 * [auth] enable_signup, and Bob is invite-only by design --
 * scripts/invite-only.test.ts pins that switch off. Nothing here creates an
 * auth.users row, so nobody on the waitlist can obtain a JWT. A member becomes
 * a real account later, through the existing admin-API invite flow.
 *
 * Because this function holds the service role, it is the only thing that can
 * read or write bob.waitlist (RLS is forced with no policies, and the schema
 * has no PostgREST endpoint). Every rule below is therefore enforced here, and
 * here is the only place it can be enforced.
 *
 *   POST { action: "request", email, source? }  -> { ok: true }
 *   POST { action: "verify",  email, code }     -> { ok: true, verified: true }
 *
 * Both answer the same shape whatever the underlying state, so the endpoint
 * cannot be used to test whether an address is on the list.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { required, sendMail } from "../_shared/mailer.ts";
import { renderEmail } from "../_shared/email/render.ts";
import { waitlistCode, waitlistJoined, waitlistAdminJoined } from "../_shared/email/templates/waitlist.ts";

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
/** Minimum gap between sends to one address; also the abuse brake. */
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_BODY_BYTES = 4096;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The uniform answer. A wrong code, an expired code, an address that was never
 * sent one and an address already on the list must be indistinguishable from
 * outside, or this endpoint becomes an address oracle. Only `verify` with a
 * genuinely correct code answers differently.
 */
const ACCEPTED = { ok: true } as const;

function looksLikeEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

/**
 * sha256(code || pepper). The pepper is a secret, so a stolen database dump
 * alone does not let an attacker precompute the 10^6 possible digests.
 *
 * The comparison itself happens inside waitlist_confirm, as a bytea equality.
 * There is no timing oracle to defend against there: a caller submits a
 * six-digit code, never a hash, so nothing they control is compared byte by
 * byte against a secret. The five-attempt limit is what actually bounds
 * guessing.
 */
async function hashCode(code: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(
    code + required("WAITLIST_CODE_PEPPER"),
  );
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** Six digits from rejection-free uniform randomness, not Math.random(). */
function generateCode(): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

/** Plain hex, no "\\x" prefix: the RPCs take text and decode(..., 'hex') it. */
function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function db() {
  // Default (public) schema on purpose: PostgREST only serves the schemas in
  // config.toml's [api] list, and `bob` is deliberately not one of them. A
  // client set to db.schema = "bob" gets PGRST106 whatever key it holds --
  // the service role bypasses RLS, not the schema allow-list. The two definer
  // RPCs below live in `public` and are granted to service_role alone.
  return createClient(
    required("SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
}

async function handleRequest(email: string, source: string): Promise<Response> {
  const code = generateCode();

  // One statement decides the cooldown and writes the hash. The previous
  // read-then-write here could interleave between two simultaneous requests
  // and mail two codes for one address; the conflict predicate cannot.
  const { data, error } = await db().rpc("waitlist_begin", {
    p_email: email,
    p_source: source,
    p_code_hash_hex: bytesToHex(await hashCode(code)),
    p_ttl_seconds: CODE_TTL_MINUTES * 60,
    p_cooldown_seconds: RESEND_COOLDOWN_SECONDS,
  });

  if (error) {
    console.error("waitlist: begin failed");
    return json({ ok: false, error: "internal" }, 500);
  }

  // Inside the cooldown: answer exactly as if a code had been sent, and send
  // nothing. The caller must not learn that this address was asked about
  // recently, and the live code must keep working.
  if (typeof data !== "string" || !data.startsWith("sent:")) return json(ACCEPTED);
  const generationToken = data.slice("sent:".length);

  try {
    // No BCC: unlike the auth hook, this mail is not a credential for any
    // existing account, and mirroring every waitlist code into a mailbox is
    // needless exposure.
    await sendMail({
      to: email,
      ...renderEmail(waitlistCode.build({ code, ttlMinutes: CODE_TTL_MINUTES })),
    });
  } catch {
    const { error: clearError } = await db().rpc("waitlist_send_failed", {
      p_email: email,
      p_generation_token: generationToken,
    });
    if (clearError) console.error("waitlist: failed-send cleanup failed");
    console.error("waitlist: send failed");
    return json({ ok: false, error: "send_failed" }, 502);
  }

  return json(ACCEPTED);
}

async function handleVerify(email: string, code: string): Promise<Response> {
  // The RPC locks the row, so two submissions racing cannot both spend the
  // same attempt. It distinguishes first and returning verification only after a valid code:
  // wrong hash, expired, out of attempts and no-such-address are one case.
  const { data, error } = await db().rpc("waitlist_confirm", {
    p_email: email,
    p_code_hash_hex: bytesToHex(await hashCode(code)),
    p_max_attempts: MAX_ATTEMPTS,
  });

  if (error) {
    console.error("waitlist: confirm failed");
    return json({ ok: false, error: "internal" }, 500);
  }

  const verified = data === "verified" || data === "already_verified";
  // waitlist_confirm answers "verified" only while verified_at is still null,
  // so this is the first verification of this address, never a repeat.
  if (data === "verified") await Promise.all([sendWelcome(email), sendAdminNotification(email)]);
  return json({ ok: true, verified });
}

/**
 * Best-effort: the address is already on the list, so a failed welcome must
 * not change the answer. Logs a fixed code, never the address.
 */
async function sendWelcome(email: string): Promise<void> {
  try {
    await sendMail({ to: email, ...renderEmail(waitlistJoined.build({})) });
  } catch {
    console.error("waitlist: welcome send failed");
  }
}

/** Independent best-effort delivery: a welcome failure cannot suppress this notice. */
async function sendAdminNotification(email: string): Promise<void> {
  try {
    const to = required("WAITLIST_NOTIFY_EMAIL").trim();
    if (!looksLikeEmail(to) || to.length > 254 || /[<>,;]/.test(to)) throw new Error("invalid_recipient");
    await sendMail({
      to,
      ...renderEmail(waitlistAdminJoined.build({ email })),
    });
  } catch {
    console.error("waitlist: admin notification failed");
  }
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  let body: unknown;
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ ok: false, error: "bad_request" }, 400);
    }
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  const input = body as Record<string, unknown>;
  if (input.action !== "request" && input.action !== "verify") {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  if (typeof input.email !== "string") {
    return json({ ok: false, error: "invalid_email" }, 400);
  }
  if (input.source !== undefined && typeof input.source !== "string") {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  if (input.code !== undefined && typeof input.code !== "string") {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  const email = input.email.trim().toLowerCase();
  if (!looksLikeEmail(email) || email.length > 254) {
    return json({ ok: false, error: "invalid_email" }, 400);
  }

  try {
    if (input.action === "request") {
      return await handleRequest(
        email,
        typeof input.source === "string" && /^[a-z0-9_-]{1,40}$/i.test(input.source.trim())
          ? input.source.trim()
          : "landing",
      );
    }
    if (input.action === "verify") {
      const code = typeof input.code === "string" ? input.code.trim() : "";
      if (!/^\d{6}$/.test(code)) return json({ ok: true, verified: false });
      return await handleVerify(email, code);
    }
    return json({ ok: false, error: "bad_request" }, 400);
  } catch {
    console.error("waitlist: request failed");
    return json({ ok: false, error: "internal" }, 500);
  }
}

export async function handleWaitlist(req: Request): Promise<Response> {
  const headers = new Headers({
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  });
  const allowed = new Set(["https://www.heybob.xyz", Deno.env.get("WAITLIST_ALLOWED_ORIGIN")]);
  const origin = req.headers.get("origin");
  if (origin && allowed.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  const response = req.method === "OPTIONS" ? new Response("ok") : await handle(req);
  headers.forEach((value, name) => response.headers.set(name, value));
  return response;
}

if (import.meta.main) Deno.serve(handleWaitlist);
