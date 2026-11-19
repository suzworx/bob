import { assertEquals } from "jsr:@std/assert@1";
import { createHandler } from "./handler.ts";

const SECRET = "test-secret";

function setup(result: "created" | "exists" | "throw" = "created") {
  const calls: string[] = [];
  const lines: string[] = [];
  const handler = createHandler({
    secret: SECRET,
    createUser: (email: string) => {
      calls.push(email);
      if (result === "throw") return Promise.reject(new Error("admin api down"));
      return Promise.resolve(result);
    },
    log: (line: string) => lines.push(line),
  });
  return { handler, calls, lines };
}

function post(
  body: unknown,
  auth: string | null = `Bearer ${SECRET}`,
  method = "POST",
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (auth !== null) headers.authorization = auth;
  return new Request("http://localhost/invite-account", {
    method,
    headers,
    body: method === "GET"
      ? undefined
      : typeof body === "string"
      ? body
      : JSON.stringify(body),
  });
}

async function read(res: Response): Promise<[number, unknown]> {
  return [res.status, await res.json()];
}

Deno.test("405 for anything but POST", async () => {
  const { handler, calls } = setup();
  assertEquals(await read(await handler(post(null, undefined, "GET"))), [
    405,
    { ok: false, error: "method_not_allowed" },
  ]);
  assertEquals(calls, []);
});

Deno.test("401 for a missing or wrong bearer", async () => {
  const { handler, calls } = setup();
  const good = { email: "a@example.com" };
  for (const auth of [null, "Bearer nope", `Basic ${SECRET}`, "Bearer "]) {
    assertEquals(await read(await handler(post(good, auth))), [
      401,
      { ok: false, error: "unauthorized" },
    ]);
  }
  assertEquals(calls, []);
});

Deno.test("401 when the configured secret is empty", async () => {
  const handler = createHandler({
    secret: "",
    createUser: () => Promise.resolve("created"),
    log: () => {},
  });
  const [status] = await read(
    await handler(post({ email: "a@example.com" }, "Bearer ")),
  );
  assertEquals(status, 401);
});

Deno.test("400 for a bad body, an oversized body or a bad address", async () => {
  const { handler, calls } = setup();
  const bad = [
    "not json",
    [],
    null,
    {},
    { email: 42 },
    { email: "no-at-sign" },
    { email: "a b@example.com" },
    { email: `${"a".repeat(250)}@example.com` },
    { email: "a@example.com", pad: "x".repeat(5000) },
  ];
  for (const body of bad) {
    assertEquals(await read(await handler(post(body))), [
      400,
      { ok: false, error: "bad_request" },
    ]);
  }
  assertEquals(calls, []);
});

Deno.test("200 created, with the address normalised first", async () => {
  const { handler, calls, lines } = setup("created");
  assertEquals(
    await read(await handler(post({ email: "  Arjun@Example.COM " }))),
    [200, { ok: true, created: true }],
  );
  assertEquals(calls, ["arjun@example.com"]);
  assertEquals(lines, ["invite-account outcome=created"]);
});

Deno.test("200 not created when the account already exists", async () => {
  const { handler, lines } = setup("exists");
  assertEquals(await read(await handler(post({ email: "a@example.com" }))), [
    200,
    { ok: true, created: false },
  ]);
  assertEquals(lines, ["invite-account outcome=exists"]);
});

Deno.test("502 when account creation throws; logs never carry the address", async () => {
  const { handler, lines } = setup("throw");
  assertEquals(await read(await handler(post({ email: "a@example.com" }))), [
    502,
    { ok: false, error: "provision_failed" },
  ]);
  assertEquals(lines, ["invite-account outcome=provision_failed"]);
  assertEquals(lines.some((l) => l.includes("example.com")), false);
});
