/**
 * The scripted stub chat model: TEST INFRASTRUCTURE, never product behaviour. It maps a handful of
 * fixed `e2e ...` sentences to one tool call each, so the UI suite gets real tool calls without a
 * provider; any other input gets the `System test response: <input>` echo.
 *
 * It can only be built when scriptedStubAllowed() says so: the AI stubs are on
 * and BOB_PRODUCTION is not 1. Nothing here is a phrase rule for real users.
 */
import { ToolLoopAgent, stepCountIs, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { scriptedStubAllowed } from './config.ts';
import { BOB_MAX_AGENT_STEPS } from './agents.ts';

/** One scripted sentence: the exact test wording and the tool call it makes. */
interface StubScriptEntry {
  id: string;
  pattern: RegExp;
  toolName: string;
  input: (match: RegExpMatchArray) => Record<string, unknown>;
}

/** The fixed tool call a scripted sentence resolves to. */
interface StubToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

/** The whole script. Each pattern is anchored: a sentence matches exactly or not at all. */
export const STUB_SCRIPT: readonly StubScriptEntry[] = [
  {
    id: 'create-app',
    pattern: /^e2e make an app called (.{1,80})$/i,
    toolName: 'propose_bob_app',
    input: (match) => ({ definition: {
      schemaVersion: 1, title: match[1] ?? '', lifecycle: 'keep',
      tables: [{ id: 'items', fields: [{ id: 'text', type: 'text' }, { id: 'done', type: 'boolean' }] }],
      actions: [{ id: 'add_item', table: 'items', operation: 'create' }, { id: 'update_item', table: 'items', operation: 'update' }],
      metrics: [], views: [{ id: 'main', kind: 'checklist', title: match[1] ?? '', table: 'items', fields: ['text', 'done'], actions: ['add_item', 'update_item'] }],
    } }),
  },
  {
    id: 'rename-bound-app',
    pattern: /^e2e rename this app to (.{1,80})$/i,
    toolName: 'read_bob_app',
    input: () => ({}),
  },
  {
    id: 'app-idea',
    pattern: /^e2e save an app idea called (.{1,2000})$/i,
    toolName: 'save_app_idea',
    input: (match) => ({ text: match[1] ?? '' }),
  },
  {
    id: 'create-task',
    pattern: /^e2e add a task called (.{1,80})$/i,
    toolName: 'create_task',
    input: (match) => ({ title: match[1] ?? '' }),
  },
  {
    id: 'set-timer',
    pattern: /^e2e start a (\d{1,3}) minute timer called (.{1,60})$/i,
    toolName: 'set_timer',
    input: (match) => ({ duration: `PT${match[1] ?? '1'}M`, label: match[2] ?? '' }),
  },
  {
    // `when` is N minutes from the call, so the reminder is in the future whatever clock the suite runs on.
    id: 'create-reminder',
    pattern: /^e2e remind me in (\d{1,3}) minutes to (.{1,80})$/i,
    toolName: 'create_reminder',
    input: (match) => ({
      text: match[2] ?? '',
      when: new Date(Date.now() + Number(match[1] ?? '1') * 60_000).toISOString(),
    }),
  },
  {
    id: 'animal-riddles',
    pattern: /^e2e play animal riddles as ([a-z]{1,20})$/i,
    toolName: 'start_game',
    input: (match) => ({ game: 'animal_riddles', players: [{ name: match[1] ?? '' }] }),
  },
  {
    id: 'marketing-campaign',
    pattern: /^e2e create a marketing campaign called (.{1,80})$/i,
    toolName: 'create_campaign',
    input: (match) => ({ name: match[1] ?? '', goal: 'beta_interest', channels: ['instagram', 'linkedin'] }),
  },
  {
    id: 'marketing-instagram-draft',
    pattern: /^e2e save an instagram draft called (.{1,500})$/i,
    toolName: 'save_draft',
    input: (match) => ({
      channel: 'instagram', format: 'image', body: match[1] ?? '', altText: 'Original Bob artwork', pillar: 'Joy',
      approvedAssetIds: ['bob-playful'], claimIds: [], cta: 'none',
    }),
  },
  {
    id: 'marketing-linkedin-draft',
    pattern: /^e2e save a linkedin draft called (.{1,500})$/i,
    toolName: 'save_draft',
    input: (match) => ({
      channel: 'linkedin', format: 'text', body: match[1] ?? '', altText: 'Original Bob artwork', pillar: 'Joy',
      approvedAssetIds: ['bob-playful'], claimIds: [], cta: 'none',
    }),
  },
  {
    id: 'marketing-week-plan',
    pattern: /^e2e plan a week called (.{1,80})$/i,
    toolName: 'save_week_plan',
    input: (match) => ({
      name: match[1] ?? '', goal: 'beta_interest', channels: ['instagram', 'linkedin'],
      story: 'Bob spends one ordinary week looking for small chances to make someone smile.',
      posts: ['Hello', 'A small moment', 'What Bob does', 'A little surprise', 'Behind the scenes', 'An honest limit', 'Come along'].map((beat, index) => {
        const channel = index % 2 === 0 ? 'instagram' : 'linkedin';
        return {
          day: index + 1, channel, pillar: 'Small joys', beat, body: `Day ${index + 1}: ${beat}.`, claimIds: ['mission.lightens-moods'],
          ...(channel === 'instagram' ? { altText: 'Original Bob artwork', approvedAssetIds: ['bob-playful'] } : {}),
        };
      }),
    }),
  },
  {
    id: 'marketing-review-note',
    pattern: /^e2e add a marketing review note called (.{1,1000})$/i,
    toolName: 'add_marketing_review_note',
    input: (match) => ({ text: match[1] ?? '' }),
  },
  {
    id: 'marketing-content-grouping',
    pattern: /^e2e group marketing content by pillar$/i,
    toolName: 'propose_marketing_config',
    input: () => ({ expectedConfigRevision: 1, config: {
      visibleViews: ['campaign', 'content', 'schedule', 'results'], contentGrouping: 'pillar', defaultChannels: ['instagram', 'linkedin'],
    } }),
  },
];

/** The scripted tool call for `text`, or null when it is not a test sentence. */
export function scriptStubTurn(text: string): StubToolCall | null {
  const sentence = text.trim();
  for (const entry of STUB_SCRIPT) {
    const match = sentence.match(entry.pattern);
    if (match) return { toolName: entry.toolName, input: entry.input(match) };
  }
  return null;
}

type CallOptions = MockLanguageModelV4['doGenerateCalls'][number];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0, text: 0, reasoning: 0 },
  totalTokens: 0,
};

/** What the model does next: call a tool, or answer in text. */
type StubStep = { kind: 'tool'; call: StubToolCall; id: string } | { kind: 'text'; text: string };

/** Text of every text part in a prompt message's content. */
function contentText(content: CallOptions['prompt'][number]['content']): string {
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

const appReadSchema = z.object({ ok: z.literal(true), data: z.object({ revision: z.number().int().min(1), definition: z.looseObject({ title: z.string() }) }) });

function appRevisionStep(options: Pick<CallOptions, 'prompt' | 'tools'>): StubStep | undefined {
  const last = options.prompt.at(-1);
  if (last?.role !== 'tool' || !options.tools?.some((offered) => offered.name === 'revise_bob_app')) return undefined;
  const lastUser = [...options.prompt].reverse().find((message) => message.role === 'user');
  const match = lastUser && contentText(lastUser.content).trim().match(/^e2e rename this app to (.{1,80})$/i);
  if (!match) return undefined;
  const result = last.content.find((part) => part.type === 'tool-result' && part.toolName === 'read_bob_app');
  if (result?.type !== 'tool-result' || result.output.type !== 'json') return undefined;
  const parsed = appReadSchema.safeParse(result.output.value);
  if (!parsed.success) return undefined;
  return { kind: 'tool', id: `stub-revise-${options.prompt.length}`, call: { toolName: 'revise_bob_app',
    input: { expectedRevision: parsed.data.data.revision, definition: { ...parsed.data.data.definition, title: match[1] } } } };
}

/** The next step for a prompt: a tool result gets its fixed line, a user sentence its call. */
function nextStubStep({ prompt, tools }: CallOptions): StubStep {
  const revision = appRevisionStep({ prompt, tools });
  if (revision) return revision;
  const last = prompt[prompt.length - 1];
  if (last?.role === 'tool') {
    const result = last.content.find((part) => part.type === 'tool-result');
    return { kind: 'text', text: `Stub: ${result?.toolName ?? 'tool'} finished.` };
  }
  const lastUser = [...prompt].reverse().find((message) => message.role === 'user');
  const text = lastUser ? contentText(lastUser.content).trim() : '';
  const call = scriptStubTurn(text);
  if (call && tools?.some((offered) => offered.name === call.toolName)) return { kind: 'tool', call, id: `stub-call-${prompt.length}` };
  return { kind: 'text', text: `System test response: ${text}` };
}

function generateResult(step: StubStep): GenerateResult {
  if (step.kind === 'text') {
    return { content: [{ type: 'text', text: step.text }], finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE, warnings: [] };
  }
  return {
    content: [{ type: 'tool-call', toolCallId: step.id, toolName: step.call.toolName, input: JSON.stringify(step.call.input) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: USAGE,
    warnings: [],
  };
}

function streamParts(step: StubStep): StreamPart[] {
  const parts: StreamPart[] = [{ type: 'stream-start', warnings: [] }];
  if (step.kind === 'text') {
    parts.push({ type: 'text-start', id: 'stub' }, { type: 'text-delta', id: 'stub', delta: step.text }, { type: 'text-end', id: 'stub' });
  } else {
    parts.push({ type: 'tool-call', toolCallId: step.id, toolName: step.call.toolName, input: JSON.stringify(step.call.input) });
  }
  const unified = step.kind === 'text' ? 'stop' : 'tool-calls';
  parts.push({ type: 'finish', finishReason: { unified, raw: unified }, usage: USAGE });
  return parts;
}

/**
 * The scripted chat model. Throws unless scriptedStubAllowed(): outside stub
 * mode, or under BOB_PRODUCTION=1, it cannot be built at all.
 */
export function createStubChatModel(env: NodeJS.ProcessEnv = process.env): MockLanguageModelV4 {
  if (!scriptedStubAllowed(env)) {
    throw new Error('the scripted stub agent needs BOB_AI_STUB=scripted and is refused when BOB_PRODUCTION=1');
  }
  return new MockLanguageModelV4({
    modelId: 'bob-stub',
    doGenerate: async (options) => generateResult(nextStubStep(options)),
    doStream: async (options) => {
      const parts = streamParts(nextStubStep(options));
      return {
        stream: new ReadableStream<StreamPart>({
          start(controller): void {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  });
}

/**
 * The web turn's agent in scripted stub mode: the scripted model over exactly
 * the tools the real turn offered, so a scripted call runs the real tool
 * against the real store. At most two steps are ever needed (call, answer);
 * the cap is every agent's, BOB_MAX_AGENT_STEPS. Throws as createStubChatModel does.
 */
export function createScriptedStubAgent(tools: ToolSet, env: NodeJS.ProcessEnv = process.env): ToolLoopAgent {
  return new ToolLoopAgent({ model: createStubChatModel(env), tools, stopWhen: stepCountIs(BOB_MAX_AGENT_STEPS) });
}
