/**
 * Spec 015 U3 characterization: every current call-site configuration of the
 * per-turn agent, recorded on the base tree. Each row records the offered tool
 * keys in order, a sha256 of the instructions, a sha256 of the rendered
 * per-turn context (fixed date and zone), the specialist delegates and the step
 * cap. The TURN_PROFILES refactor must leave every row byte-identical. No network.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tool, type StopCondition, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';

/** Every agent construction's settings, in order. */
const constructed = vi.hoisted((): Array<Record<string, unknown>> => []);

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  const Recorded = new Proxy(actual.ToolLoopAgent, {
    construct(target, args, newTarget): object {
      constructed.push(args[0] as Record<string, unknown>);
      return Reflect.construct(target, args, newTarget) as object;
    },
  });
  return { ...actual, ToolLoopAgent: Recorded };
});

const { createBobAgent } = await import('../src/agents.ts');
// Loading it registers the Marketing delegate, as the package index does in production.
const { marketingTaskContext, marketingToolNames } = await import('../src/marketing-agent.ts');

type AgentOptions = NonNullable<Parameters<typeof createBobAgent>[0]>;

const NOW = new Date('2026-09-22T15:52:00Z');
const ZONE = 'Europe/London';
const MEMORY = '[BOB MEMORY]\n- likes tea\n[END BOB MEMORY]';
const cap = (name: string): Tool => tool({ description: `${name}.`, inputSchema: z.object({}), execute: async (): Promise<string> => 'ok' });
const tools = (...names: string[]): Record<string, Tool> => Object.fromEntries(names.map((name) => [name, cap(name)]));
const keep = (set: Record<string, Tool>): Record<string, Tool> => set;
const noTools = (): Record<string, Tool> => ({});
const neverStop: StopCondition<ToolSet> = () => false;

const PRIVATE_CAPS = ['set_timer', 'list_tasks', 'create_task', 'propose_bob_app', 'list_bob_apps', 'read_marketing_config', 'marketing_context', 'save_draft', 'search_gmail'];
const privateTurn = (): AgentOptions => ({
  filterTools: keep, memoryContext: MEMORY, memoryTools: tools('remember', 'forget'), capabilityTools: tools(...PRIVATE_CAPS),
  lateTools: tools('set_volume', 'device_status'), timeZone: ZONE, cacheKey: 'conversation-1',
  taskContext: marketingTaskContext('posts'), contextToolNames: [...marketingToolNames],
});
const boundApp = (): AgentOptions => ({
  filterTools: keep, memoryTools: {}, capabilityTools: tools('read_bob_app', 'revise_bob_app', 'save_app_idea'),
  lateTools: {}, timeZone: ZONE, cacheKey: 'conversation-1',
});
const groupTurn = (): AgentOptions => ({
  capabilityTools: tools('list_tasks', 'create_task', 'list_space_members'), memoryTools: {}, timeZone: ZONE, filterTools: keep,
});
const sharedTurn = (names: string[]): AgentOptions => ({
  ...groupTurn(), capabilityTools: { ...tools(...names), ...tools('list_tasks', 'create_task', 'list_space_members') },
  contextToolNames: [...marketingToolNames], taskContext: marketingTaskContext('posts'),
});
const MARKETING = ['marketing_context', 'save_draft', 'read_marketing_config', 'propose_marketing_config'];
const GENERIC = ['read_bob_app', 'revise_bob_app', 'save_app_idea'];

/** Each current call site's data, as the base tree's callers built it, now with its mode in place of the legacy fields. */
const CONFIGURATIONS: Record<string, () => AgentOptions> = {
  device: () => ({ ...privateTurn(), taskContext: undefined, contextToolNames: undefined, mode: 'device', stopWhen: neverStop }),
  device_degraded: () => ({ mode: 'device_degraded', filterTools: noTools }),
  unpaired: () => ({}),
  chat: () => ({ ...privateTurn(), mode: 'chat' }),
  chat_degraded: () => ({ filterTools: noTools, mode: 'chat_degraded' }),
  web_voice: () => ({ ...privateTurn(), mode: 'web_voice' }),
  web_voice_degraded: () => ({ filterTools: noTools, mode: 'web_voice_degraded' }),
  bound_app: () => ({ ...boundApp(), mode: 'bound_app' }),
  bound_app_voice: () => ({ ...boundApp(), mode: 'bound_app_voice' }),
  group: () => ({ ...groupTurn(), mode: 'group' }),
  shared_app_run: () => ({ ...sharedTurn(MARKETING), mode: 'shared_app_run' }),
  shared_app_refine: () => ({ ...sharedTurn(MARKETING), mode: 'shared_app_refine' }),
  shared_generic_app_refine: () => ({ ...sharedTurn(GENERIC), contextToolNames: [...GENERIC], mode: 'shared_generic_app_refine' }),
};

const sha = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 16);

/** The recorded shape of one built agent. */
export function profileOf(build: () => unknown): { tools: string[]; instructions: string; context: string; delegates: string[]; stepCap: number } {
  const before = constructed.length;
  build();
  const settings = constructed[before];
  if (!settings) throw new Error('no agent was constructed');
  const keys = Object.keys((settings.tools ?? {}) as Record<string, unknown>);
  const prepared = (settings.prepareCall as (call: object) => { messages: Array<{ role: string; content: unknown }> })({ prompt: 'Hi.' });
  const stops = [settings.stopWhen].flat() as Array<StopCondition<ToolSet>>;
  const stepCap = Array.from({ length: 30 }, (_, index) => index + 1)
    .find((count) => stops.some((stop) => stop({ steps: Array.from({ length: count }) } as never))) ?? -1;
  return {
    tools: keys,
    instructions: sha(settings.instructions),
    context: sha(prepared.messages.find((message) => message.role === 'system')?.content),
    delegates: keys.filter((key) => key.endsWith('_agent')),
    stepCap,
  };
}

/** The production bytes (HONEST rule on), re-recorded when the single Bob brand dropped the per-turn name line. */
const INSTRUCTIONS = '5cd57d574526991e';
const PRIVATE_DELEGATES = ['apps_agent', 'productivity_agent', 'marketing_agent', 'health_agent'];
const PRIVATE_TOOLS = ['currentDateTime', 'set_timer', 'list_tasks', 'create_task', 'search_gmail', 'remember', 'forget', 'set_volume', 'device_status', ...PRIVATE_DELEGATES];
const GROUP_TOOLS = ['currentDateTime', 'list_tasks', 'create_task', 'list_space_members'];
const row = (context: string, tools: string[]): ReturnType<typeof profileOf> => ({
  tools, instructions: INSTRUCTIONS, context, delegates: tools.filter((key) => key.endsWith('_agent')), stepCap: 6,
});
const EXPECTED: Record<string, ReturnType<typeof profileOf>> = {
  device: row('000b154a3357af13', PRIVATE_TOOLS),
  device_degraded: row('95348c6211730ab2', []),
  unpaired: row('95fd5798adfb5a43', ['currentDateTime']),
  chat: row('a315972ebd63e732', PRIVATE_TOOLS),
  chat_degraded: row('db787357c0a143ce', []),
  web_voice: row('a2803cfc0e3b816c', PRIVATE_TOOLS),
  web_voice_degraded: row('95348c6211730ab2', []),
  bound_app: row('962d2ad67d901c29', ['currentDateTime', 'apps_agent']),
  bound_app_voice: row('92acfc45d2f73f33', ['currentDateTime', 'apps_agent']),
  group: row('ad3b7a975eb88656', GROUP_TOOLS),
  shared_app_run: row('0180aba5de542d77', [...GROUP_TOOLS, 'marketing_agent']),
  shared_app_refine: row('ad3b7a975eb88656', [...GROUP_TOOLS, 'apps_agent']),
  shared_generic_app_refine: row('ad3b7a975eb88656', [...GROUP_TOOLS, 'apps_agent']),
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); });

describe('turn profiles characterization', () => {
  it.each(Object.keys(CONFIGURATIONS))('%s builds the recorded agent', (name) => {
    const options = CONFIGURATIONS[name];
    if (!options) throw new Error(name);
    expect(profileOf(() => createBobAgent(options()))).toEqual(EXPECTED[name]);
  });
});

const { BOB_MAX_AGENT_STEPS, TURN_PROFILES, bobAgent } = await import('../src/agents.ts');
const { createScriptedStubAgent } = await import('../src/stub-agent.ts');
type Mode = keyof typeof TURN_PROFILES;

/** A configuration's mode and data, without the no-tools filter a degraded row supplies itself. */
function moded(mode: Mode): AgentOptions {
  const options = CONFIGURATIONS[mode]?.() ?? {};
  const kept = Object.entries(options).filter(([key]) => TURN_PROFILES[mode].tools || key !== 'filterTools');
  return { ...Object.fromEntries(kept), mode };
}

describe('TURN_PROFILES', () => {
  it('has exactly one row per recorded configuration', () => {
    expect(Object.keys(TURN_PROFILES).sort()).toEqual(Object.keys(CONFIGURATIONS).sort());
  });

  it.each(Object.keys(TURN_PROFILES) as Mode[])('the %s row, given its mode and data only, builds the recorded agent', (mode) => {
    expect(profileOf(() => createBobAgent(moded(mode)))).toEqual(EXPECTED[mode]);
  });

  it.each(['shared_app_run', 'shared_app_refine', 'shared_generic_app_refine'] as const)('the %s row refuses private memory and late tools', (mode) => {
    const refusal = 'A shared app requires group replies without private memory or late tools';
    expect(() => createBobAgent({ ...moded(mode), memoryTools: tools('remember') })).toThrow(refusal);
    expect(() => createBobAgent({ ...moded(mode), lateTools: tools('set_volume') })).toThrow(refusal);
    expect(() => createBobAgent({ ...moded(mode), memoryContext: MEMORY })).toThrow(refusal);
  });

  it('refuses game hooks off the device rows, and an omitted mode is the unpaired row', () => {
    expect(() => createBobAgent({ mode: 'chat', stopWhen: neverStop })).toThrow('Game hooks require a device turn');
    expect(profileOf(() => createBobAgent())).toEqual(EXPECTED.unpaired);
    expect(() => createBobAgent({ mode: 'device', stopWhen: neverStop })).not.toThrow();
  });

  it('the degraded rows offer no tools whatever the caller passes', () => {
    for (const mode of ['device_degraded', 'chat_degraded', 'web_voice_degraded'] as const) {
      expect(createBobAgent({ mode, filterTools: keep, capabilityTools: tools('list_tasks') }).tools).toEqual({});
    }
  });

  it('the unpaired row equals the old bobAgent singleton configuration', () => {
    const singleton = constructed[0];
    const before = constructed.length;
    createBobAgent({ mode: 'unpaired' });
    const row = constructed[before];
    expect(singleton?.tools).toBe(bobAgent.tools);
    expect(row?.tools).toBe(singleton?.tools);
    expect(row?.instructions).toEqual(singleton?.instructions);
    expect(row?.stopWhen).toBe(singleton?.stopWhen);
  });

  it("the scripted stub's step cap is BOB_MAX_AGENT_STEPS", () => {
    const before = constructed.length;
    createScriptedStubAgent({}, { BOB_AI_STUB: 'scripted' });
    const stop = constructed[before]?.stopWhen as StopCondition<ToolSet>;
    const cap = Array.from({ length: 30 }, (_, index) => index + 1).find((count) => stop({ steps: Array.from({ length: count }) } as never));
    expect(cap).toBe(BOB_MAX_AGENT_STEPS);
  });
});
