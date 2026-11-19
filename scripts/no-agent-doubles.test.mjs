// TG-AGENT-HARNESS (test-gap class A, docs/testing/escaped-defects.md defect 1):
// a test under apps/api/tests or apps/ai/tests may not fake an agent's
// `stream`/`generate` with vi.fn or a hand-written object. A hand-written
// double matches our guess of the SDK, not the SDK (ToolLoopAgent.stream() is
// async; the double was sync, and the suite stayed green). Use the real-SDK
// harness instead: apps/api/tests/support/agent-harness.ts (and paired-turn.ts
// for a whole device turn). The allowlist only shrinks: new files are refused,
// and an entry that no longer fakes an agent must be removed.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_DIRS = ['apps/api/tests', 'apps/ai/tests'];

/** Each pattern is one way a test fakes an agent's stream/generate. */
export const AGENT_DOUBLE_PATTERNS = [
  /\b(?:stream|generate)\s*:\s*vi\.fn\b/, // { stream: vi.fn() }
  /\b(?:stream|generate)\s*:\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>)/, // { generate: async () => ... }
  /(?:^|[{,])\s*async\s+(?:stream|generate)\s*\([^)]*\)\s*(?::[^{]+)?\{/m, // { async generate() { ... } }
  /^\s*(?:stream|generate)\s*\([^)]*\)\s*(?::[^{]+)?\{/m, // { stream() { ... } }
  /\.(?:stream|generate)\)\s*\.mock(?:Implementation|ResolvedValue|ReturnValue|RejectedValue)/, // vi.mocked(a.stream).mockImplementation
  /vi\.spyOn\([^,]+,\s*['"](?:stream|generate)['"]\)\s*\.mock(?:Implementation|ResolvedValue|ReturnValue|RejectedValue)/,
];

/** Files that still fake an agent, each with why; migration is a later unit. */
export const ALLOWLIST = {
  'apps/api/tests/voice/cancel.test.ts': 'cancel timing drives a hand-paced stream double; move to harness delay/abort parts',
  'apps/api/tests/conversations/core-invocations-stub.test.ts': 'an injected createAgent returns a hand-written generate; inject a harness agent',
  'apps/api/tests/conversations/core-invocations.test.ts': '@bob invocations inject hand-written generate agents; inject harness agents',
  'apps/api/tests/voice/device-auth-legacy.test.ts': 'legacy device auth only needs a canned reply; use a one-step harness agent',
  'apps/api/tests/voice/device-control-e2e.test.ts': 'a hand-written generate calls set_volume; script the tool call in the harness',
  'apps/api/tests/voice/device-control-turn.test.ts': 'device tool turns fake the model deciding a tool; script it in the harness',
  'apps/api/tests/memory/e2e-memory-parity.db.test.ts': 'memory parity across surfaces uses canned agent replies; use harness agents',
  'apps/api/tests/voice/games-scope.test.ts': 'spies createBobAgent options behind a hand-written agent; wrap pairedAgent',
  'apps/api/tests/voice/isolation.test.ts': 'account isolation turns use a canned agent reply; use a one-step harness agent',
  'apps/api/tests/voice/journal-vocabulary.test.ts': 'journal event names need any reply; use a one-step harness agent',
  'apps/api/tests/voice/memory-embedder-wiring.test.ts': 'embedder wiring turns use a canned agent reply; use a harness agent',
  'apps/api/tests/conversations/memory-turn-hooks.test.ts': 'memory hooks fake remember/forget calls by hand; script them in the harness',
  'apps/api/tests/spaces/tool-wiring.test.ts': 'tool registry turns fake the agent to read its options; wrap pairedAgent',
  'apps/api/tests/voice/turn-prompt-layout.test.ts': 'mixes MockLanguageModelV4 with a vi.fn singleton; build on the harness',
  'apps/api/tests/voice/turn-short-audio.test.ts': 'asserts the agent is never called; a failing harness agent proves it',
  'apps/api/tests/spaces/turn-space.test.ts': 'Space-scoped turns use a canned agent reply; use a harness agent',
  'apps/api/tests/voice/turn-streaming.test.ts': 'word-timed StreamTextResult double for TTS latency; use harness delays',
  'apps/api/tests/voice/turn.test.ts': 'core turn paths use vi.fn generate/stream doubles; move to paired-turn.ts',
  'apps/api/tests/conversations/web-attachments.test.ts': 'web attachment turns use a vi.fn stream double; use a harness agent',
  'apps/api/tests/conversations/web-chat-disconnect.test.ts': 'web disconnect timing uses a vi.fn stream double; use harness delays',
  'apps/api/tests/conversations/web-chat.test.ts': 'web chat turns use vi.fn stream doubles; use harness agents',
};

function testFiles(dir) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...testFiles(path));
    } else if (/\.(?:[cm]?ts|[cm]?js)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** True when `source` fakes an agent's stream or generate. */
export function fakesAgent(source) {
  return AGENT_DOUBLE_PATTERNS.some((pattern) => pattern.test(source));
}

const faking = TEST_DIRS.flatMap(testFiles)
  .map((path) => relative(ROOT, join(ROOT, path)).split(sep).join('/'))
  .filter((path) => fakesAgent(readFileSync(join(ROOT, path), 'utf8')));

describe('no hand-written agent doubles (TG-AGENT-HARNESS)', () => {
  it('recognises each double form, and not the harness, the SDK mock model or an observing spy', () => {
    for (const fake of [
      'bobAgent: { generate: vi.fn(), stream: vi.fn() }',
      '{ generate: async () => ({ text: "x" }) }',
      '{ stream: (call: unknown): unknown => parts() }',
      '{ async generate(call) { return x; } }',
      '{\n  stream(call) {\n    return x;\n  },\n}',
      'vi.mocked(bobAgent.stream).mockImplementation(async () => s)',
      "vi.spyOn(agent, 'generate').mockResolvedValue(r)",
    ]) expect(fakesAgent(fake), fake).toBe(true);
    for (const real of [
      "createAgentHarness([words('Hi.')]).agent",
      'new MockLanguageModelV4({ doStream: async () => ({ stream }) })',
      "const generate = vi.spyOn(ai.bobAgent, 'generate');",
      'await agent.stream({ prompt })',
      "it('awaits the async stream() and hands deltas on', async () => {",
    ]) expect(fakesAgent(real), real).toBe(false);
  });

  it('no test outside the allowlist fakes an agent: build it on tests/support/agent-harness.ts', () => {
    expect(faking.filter((path) => !(path in ALLOWLIST))).toEqual([]);
  });

  it('every allowlist entry still fakes an agent (remove it once migrated) and says why', () => {
    expect(Object.keys(ALLOWLIST).filter((path) => !faking.includes(path))).toEqual([]);
    for (const [path, reason] of Object.entries(ALLOWLIST)) expect(reason.trim().length, path).toBeGreaterThan(10);
  });
});
