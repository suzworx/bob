/**
 * invite-account: gives an invited address a confirmed account, so its owner
 * can sign in with an emailed code and accept a space invitation. Bob is
 * invite-only (signups stay off), and the API holds no service-role key, so
 * account creation happens here. Nothing is emailed from this function.
 * Everything it needs arrives through `deps`, so the contract below is
 * testable without Supabase or Deno.env.
 *
 *   POST { email }  Authorization: Bearer <NOTIFY_EMAIL_SECRET>
 *   200 {ok:true, created} | 400 bad_request | 401 unauthorized
 *   405 method_not_allowed | 502 provision_failed
 */

const MAX_BODY_BYTES = 4 * 1024;
const MAX_ADDRESS_LENGTH = 254;

type InviteDeps = {
  secret: string;
  createUser: (email: string) => Promise<"created" | "exists">;
  log?: (line: string) => void;
};

function answer(
  status: number,
  body: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fail = (status: number, error: string): Response =>
  answer(status, { ok: false, error });

function looksLikeEmail(value: string): boolean {
  return value.length <= MAX_ADDRESS_LENGTH &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compares SHA-256 digests rather than the raw strings, so the loop always
 * runs over 32 bytes and neither length nor content leaks through timing.
 * Same technique as notify-email/handler.ts.
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

export function createHandler(
  deps: InviteDeps,
): (req: Request) => Promise<Response> {
  const log = deps.log ?? ((line: string): void => console.log(line));
  // Outcome only: never the address.
  const outcome = (result: string): void =>
    log(`invite-account outcome=${result}`);

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return fail(405, "method_not_allowed");

    const header = req.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!deps.secret || !token || !(await sameSecret(token, deps.secret))) {
      outcome("unauthorized");
      return fail(401, "unauthorized");
    }

    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) {
      outcome("bad_request");
      return fail(400, "bad_request");
    }
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength > MAX_BODY_BYTES) {
      outcome("bad_request");
      return fail(400, "bad_request");
    }

    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      outcome("bad_request");
      return fail(400, "bad_request");
    }
    const email = isObject(body) && typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : "";
    if (!looksLikeEmail(email)) {
      outcome("bad_request");
      return fail(400, "bad_request");
    }

    let result: "created" | "exists";
    try {
      result = await deps.createUser(email);
    } catch {
      outcome("provision_failed");
      return fail(502, "provision_failed");
    }
    outcome(result);
    return answer(200, { ok: true, created: result === "created" });
  };
}
