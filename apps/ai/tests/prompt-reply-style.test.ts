/**
 * #898: the turn's mode (its TURN_PROFILES row) tells the agent how its reply will be shown.
 * `turnContextText` appends the style line to the per-turn context message,
 * which `createBobAgent` sends before the final user message. Unset adds no
 * line (c4: the earlier c3 default of 'voice' broke the
 * config-identical-to-the-singleton invariant many other suites assert).
 * 'voice' is the style the #904 prod-regression now opts into: the device
 * turn (and its unpaired/degraded fallbacks), the web route, and Space
 * invocations each name their surface. Mirrors prompt-thinking-budget.test.ts's
 * ToolLoopAgent spy and env-stub pattern.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted((): { settings: Record<string, unknown>[] } => ({ settings: [] }));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  const MockedToolLoopAgent = new Proxy(actual.ToolLoopAgent, {
    construct(target, args, newTarget): object {
      captured.settings.push(args[0] as Record<string, unknown>);
      return Reflect.construct(target, args, newTarget) as object;
    },
  });
  return { ...actual, ToolLoopAgent: MockedToolLoopAgent };
});

// Both local modules are dynamically imported only after this stub runs: a
// static top-of-file import would load config.ts (and freeze BOB_CHAT_MODEL)
// before the stub takes effect.
vi.stubEnv('BOB_CHAT_MODEL', 'google/gemini-2.5-flash');
const { createBobAgent } = await import('../src/agents.ts');
const { BOB_AGENT_INSTRUCTIONS, REPLY_STYLE, dateContextLine, turnContextText } = await import('../src/prompts.ts');

beforeEach(() => {
  vi.stubEnv('BOB_CHAT_MODEL', 'google/gemini-2.5-flash');
  captured.settings.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The settings object from the most recently constructed ToolLoopAgent. */
function lastSettings(): Record<string, unknown> {
  return captured.settings.at(-1)!;
}

const now = new Date('2026-09-22T15:52:00Z');

describe('turnContextText', () => {
  it('without a style, is the memory and the date line', () => {
    const memoryContext = '[BOB MEMORY\nFact: X\n[END BOB MEMORY]';
    for (const memory of [undefined, memoryContext]) {
      const result = turnContextText(memory, now, 'UTC');
      const prefix = memory ? `${memory}\n\n${dateContextLine(now, 'UTC')}` : dateContextLine(now, 'UTC');
      expect(result).toBe(prefix);
    }
  });

  it.each(['voice', 'text', 'group'] as const)('appends %s guidance after the date', (style) => {
    const result = turnContextText(undefined, now, 'UTC', style);
    expect(result).toBe(`${dateContextLine(now, 'UTC')}\n\n${REPLY_STYLE[style]}`);
  });
});

/**
 * Correction c1 (PLAN-DAY): the voice path never reads the list_* tool
 * descriptions before deciding whether to call a tool, so "Plan my day."
 * still asked "what date?" with no tool call until this clause landed in
 * the per-turn context the voice path actually sees.
 */
describe('reply-style planning clause (PLAN-DAY c1)', () => {
  it("voice tells the model to read tasks and agenda first, and that 'my day' means today", () => {
    expect(REPLY_STYLE.voice).toContain('read the tasks and agenda first');
    expect(REPLY_STYLE.voice).toContain('"my day" means today');
  });

  it("text carries the same clause", () => {
    expect(REPLY_STYLE.text).toContain('read the tasks and agenda first');
    expect(REPLY_STYLE.text).toContain('"my day" means today');
  });
});

describe('createBobAgent reply style', () => {
  it("the 'device' row keeps instructions byte-stable and puts the voice line in the per-turn context message", () => {
    createBobAgent({ mode: 'device' });
    const settings = lastSettings();
    expect(settings.instructions).toBe(BOB_AGENT_INSTRUCTIONS);
    const prepareCall = settings.prepareCall as (opts: unknown) => { messages: Array<{ role: string; content: string }> };
    const result = prepareCall({ messages: [{ role: 'user', content: 'hi' }] });
    const contextMessage = result.messages.find((m) => m.role === 'system');
    expect(contextMessage?.content).toContain(REPLY_STYLE.voice);
  });

  it('unset: no reply-style line anywhere', () => {
    createBobAgent({});
    const settings = lastSettings();
    expect(settings.instructions).toBe(BOB_AGENT_INSTRUCTIONS);
    const prepareCall = settings.prepareCall as (opts: unknown) => { messages: Array<{ role: string; content: string }> };
    const result = prepareCall({ messages: [{ role: 'user', content: 'hi' }] });
    const contextMessage = result.messages.find((m) => m.role === 'system');
    expect(contextMessage?.content).not.toContain(REPLY_STYLE.voice);
    expect(contextMessage?.content).not.toContain(REPLY_STYLE.text);
    expect(contextMessage?.content).not.toContain(REPLY_STYLE.group);
  });
});
