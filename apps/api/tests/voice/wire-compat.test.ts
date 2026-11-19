/**
 * New firmware vs the RELEASED server (test-gap class C,
 * docs/testing/test-strategy.md §7; escaped defect 3, fixed in #574).
 *
 * The firmware host tests write every device->server builder's exact output to
 * apps/cardputer/test/fixtures/wire/emitted (npm run wire:emit). Each file must
 * 1. parse under the CURRENT schemas (src/schemas.ts), and
 * 2. parse under the RELEASED server's schemas (tests/compat/released-schemas.ts,
 *    frozen by scripts/release/schema-snapshot.mjs), OR be listed in
 *    RELEASED_FALLBACKS with the firmware fallback that recovers from the
 *    refusal, its host test, and a fallback message the released server takes.
 * A new firmware message production would refuse, with no fallback, fails here.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { z } from 'zod';

import { createSession } from '../../src/voice/session-handlers.ts';
import { handleControl } from '../../src/voice/session.ts';
import { setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { ClientControlDtoSchema } from '../../src/voice/protocol.ts';
import { ClientControlDtoSchema as ReleasedClientControlDtoSchema } from '../compat/released-schemas.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
const EMITTED = resolve(import.meta.dirname, '../../../cardputer/test/fixtures/wire/emitted');
const HOST_TESTS = resolve(import.meta.dirname, '../../../cardputer/test/host');

/** An emitted message's exact wire bytes (the trailing line break dropped). */
function raw(name: string): string {
  return readFileSync(resolve(EMITTED, `${name}.json`), 'utf8').replace(/\r?\n$/, '');
}

interface Fallback {
  /** The emitted message the firmware sends instead once refused. */
  fallback: string;
  /** Host test file and TEST_CASE proving the firmware sends it. */
  hostTest: string;
  testCase: string;
}

// #574: a server older than #345 parses hello strictly and answers fw_version /
// caps with BAD_MESSAGE; the firmware resends a bare hello {format_id} once.
const HELLO_FALLBACK = {
  hostTest: 'test_hello_fallback.cpp',
  testCase: 'BAD_MESSAGE before welcome after an extended hello sends the bare hello',
};

/** Emitted messages the released server may refuse, and how the firmware recovers.
 *  Empty since Release 1 (6ddb3e9): it ships #574, so it takes the extended hello
 *  and the four hello entries (HELLO_FALLBACK) were dropped. A future release
 *  that refuses a new firmware message lists it here with its fallback. */
const RELEASED_FALLBACKS: Record<string, Fallback> = {
  // #880: the released turn_start payload is strict {}. The released server never
  // answers cap turn_conversation, so the firmware keeps sending the bare turn_start.
  turn_start_conversation: {
    fallback: 'turn_start',
    hostTest: 'test_builders.cpp',
    testCase: 'turn_start carries conversation_id only after a welcome that accepts it (#880)',
  },
  // Both negotiated keys at once; the released server answers neither cap.
  turn_start_conversation_assistant_name: {
    fallback: 'turn_start',
    hostTest: 'test_builders.cpp',
    testCase: 'turn_start carries conversation_id only after a welcome that accepts it (#880)',
  },
};

interface SafeParser { safeParse: (data: unknown) => { success: boolean; error?: { issues: unknown } } }

const emitted = readdirSync(EMITTED)
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length));

const issues = (result: { error?: { issues: unknown } }): string => JSON.stringify(result.error?.issues);

/** Why the released server's handling of emitted message `name` is not
 *  acceptable, or undefined: it parses, or it is refused and `fallbacks` names a
 *  fallback the released server takes, proven by an existing host TEST_CASE. A
 *  listed message the released server accepts is a stale entry. */
function releasedProblem(name: string, released: SafeParser, fallbacks: Record<string, Fallback>): string | undefined {
  const result = released.safeParse(JSON.parse(raw(name)));
  const fallback = fallbacks[name];
  if (fallback === undefined) {
    return result.success ? undefined : `the released server refuses ${name} and the firmware has no fallback: ${issues(result)}`;
  }
  if (result.success) return `the released server accepts ${name}: drop it from RELEASED_FALLBACKS`;
  if (!emitted.includes(fallback.fallback)) return `fallback ${fallback.fallback} is not an emitted message`;
  const fallbackResult = released.safeParse(JSON.parse(raw(fallback.fallback)));
  if (!fallbackResult.success) return `the released server refuses fallback ${fallback.fallback}: ${issues(fallbackResult)}`;
  const hostTest = resolve(HOST_TESTS, fallback.hostTest);
  if (!existsSync(hostTest)) return `${fallback.hostTest} is missing`;
  if (!readFileSync(hostTest, 'utf8').includes(`TEST_CASE("${fallback.testCase}")`)) {
    return `${fallback.hostTest} has no TEST_CASE("${fallback.testCase}")`;
  }
  return undefined;
}

describe('wire compat: every firmware-emitted message against the current and released server', () => {
  it('finds the emitted messages', () => {
    expect(emitted.length).toBeGreaterThanOrEqual(25);
  });

  it.each(emitted)('%s is compact JSON and parses under the CURRENT schemas', (name) => {
    expect(JSON.stringify(JSON.parse(raw(name)))).toBe(raw(name));
    const result = ClientControlDtoSchema.safeParse(JSON.parse(raw(name)));
    expect(result.success, issues(result)).toBe(true);
  });

  it.each(emitted)('%s parses under the RELEASED schemas, or has a tested firmware fallback', (name) => {
    expect(releasedProblem(name, ReleasedClientControlDtoSchema, RELEASED_FALLBACKS)).toBeUndefined();
  });

  it('RELEASED_FALLBACKS names only emitted messages', () => {
    for (const name of Object.keys(RELEASED_FALLBACKS)) expect(emitted, name).toContain(name);
  });
});

// The fallback mechanism, against a synthetic released server shaped like the
// one before Release 1 (9d6655d): hello payload {format_id} only, strict.
const strictHelloServer: SafeParser = z.object({
  v: z.literal(1), type: z.literal('hello'), id: z.string(),
  payload: z.object({ format_id: z.union([z.literal(1), z.literal(2)]) }).strict(),
}).strict();

describe('wire compat: the RELEASED_FALLBACKS mechanism (synthetic strict-hello server)', () => {
  const entry = { hello_versioned: { fallback: 'hello_bare', ...HELLO_FALLBACK } };

  it('a refused message with no fallback fails', () => {
    expect(releasedProblem('hello_versioned', strictHelloServer, {})).toMatch(/refuses hello_versioned and the firmware has no fallback/);
  });

  it('a refused message with a tested fallback the server takes passes', () => {
    expect(releasedProblem('hello_versioned', strictHelloServer, entry)).toBeUndefined();
  });

  it('an entry the released server accepts is stale and fails', () => {
    expect(releasedProblem('hello_bare', strictHelloServer, { hello_bare: entry.hello_versioned })).toMatch(/drop it from RELEASED_FALLBACKS/);
  });

  it('a fallback the released server also refuses fails', () => {
    const bad = { hello_versioned: { ...entry.hello_versioned, fallback: 'hello_no_version' } };
    expect(releasedProblem('hello_versioned', strictHelloServer, bad)).toMatch(/refuses fallback hello_no_version/);
  });

  it('a fallback whose host test or TEST_CASE is missing fails', () => {
    const gone = { hello_versioned: { ...entry.hello_versioned, hostTest: 'test_no_such_file.cpp' } };
    expect(releasedProblem('hello_versioned', strictHelloServer, gone)).toMatch(/test_no_such_file.cpp is missing/);
    const renamed = { hello_versioned: { ...entry.hello_versioned, testCase: 'no such case' } };
    expect(releasedProblem('hello_versioned', strictHelloServer, renamed)).toMatch(/has no TEST_CASE/);
  });
});

// ---- The absent-version hello through the real handleControl, with a minimum set.

const closeListeners: (() => void)[] = [];
interface FakeSocket { readyState: number; send: ReturnType<typeof vi.fn>; once: (event: string, fn: () => void) => void }
const makeSocket = (): FakeSocket => ({
  readyState: 1,
  send: vi.fn(),
  once: (event, fn) => {
    if (event === 'close') closeListeners.push(fn);
  },
});
const sentTypes = (socket: FakeSocket): string[] => socket.send.mock.calls
  .map((call) => call[0])
  .filter((data): data is string => typeof data === 'string')
  .map((text) => (JSON.parse(text) as { type: string }).type);

async function helloTypes(name: string): Promise<string[]> {
  const socket = makeSocket();
  const dto = ClientControlDtoSchema.parse(JSON.parse(raw(name)));
  await handleControl(appDeps, socket as unknown as WebSocket, createSession(), dto, vi.fn());
  return sentTypes(socket);
}

const fakeDb: Db = { query: async <T>(): Promise<T[]> => [], tx: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(fakeDb) };

describe('wire compat: a hello without fw_version is never version-gated', () => {
  beforeAll(() => setSharedDb(Promise.resolve(fakeDb)));
  afterEach(() => {
    vi.unstubAllEnvs();
    closeListeners.splice(0).forEach((fn) => fn());
  });

  it('hello_no_version carries no fw_version', () => {
    expect(JSON.parse(raw('hello_no_version')).payload).not.toHaveProperty('fw_version');
  });

  it.each(['hello_no_version', 'hello_bare'])('%s gets welcome and no update_required under BOB_MIN_FW_VERSION', async (name) => {
    vi.stubEnv('BOB_MIN_FW_VERSION', '99.0.0');
    const types = await helloTypes(name);
    expect(types).toContain('welcome');
    expect(types).not.toContain('update_required');
  });

  it('control: the versioned hello below the minimum does get update_required', async () => {
    vi.stubEnv('BOB_MIN_FW_VERSION', '99.0.0');
    expect(await helloTypes('hello_versioned')).toEqual(['welcome', 'update_required']);
  });
});
