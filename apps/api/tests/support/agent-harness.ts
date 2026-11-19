/**
 * TG-AGENT-HARNESS (test-gap class A): a REAL ai-SDK ToolLoopAgent on the
 * SDK's own MockLanguageModelV4, driven by a small script of steps. Tests use
 * it instead of hand-written `stream`/`generate` doubles, so the shape the
 * turn reads (stream() is async, parts are the SDK's) is the library's, never
 * our guess of it. No network, no casts: a drift in the SDK is a type error.
 *
 * A script is one entry per model call (step). Each step is a list of parts:
 * text deltas, tool calls (answered by the real tool, or a stub returning
 * `result`), delays, a model error (optionally a given typed error, e.g. a provider 402), or an abort (fires `harness.abort`, the
 * signal a caller passes as the turn's cancel). A step with a tool call ends
 * with finishReason tool-calls, so the agent runs the next step; any other
 * step ends with stop. Running past the script's end throws.
 */
import { ToolLoopAgent, stepCountIs, tool, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';

export type ScriptPart =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input?: Record<string, unknown>; result?: unknown }
  | { type: 'delay'; ms: number }
  | { type: 'error'; message: string; error?: unknown }
  | { type: 'abort' };

export type ScriptStep = readonly ScriptPart[];

export interface HarnessOptions {
  /** Real tools the script may call; a scripted tool missing here is stubbed. */
  tools?: ToolSet;
  /** The turn's own cancel controller (a session's turnAbort); a fresh one by default. */
  abort?: AbortController;
}

/** When a step started and finished (performance.now() ms). */
export interface StepMark {
  step: number;
  event: 'start' | 'end';
  at: number;
}

export interface AgentHarness {
  agent: ToolLoopAgent;
  model: MockLanguageModelV4;
  /** The turn's cancel: pass its signal to the turn; an `abort` part fires it. */
  abort: AbortController;
  timeline: StepMark[];
  /** Model calls made so far. */
  calls: () => number;
}

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0, text: 5, reasoning: 0 },
  totalTokens: 15,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Text deltas as a model streams them: "It", " is", " sunny." */
export function words(text: string): ScriptPart[] {
  return text.split(/(?= )/).map((delta) => ({ type: 'text', text: delta }));
}

/** Builds the agent. Steps run in order; each model call takes the next one. */
export function createAgentHarness(steps: readonly ScriptStep[], options: HarnessOptions = {}): AgentHarness {
  const abort = options.abort ?? new AbortController();
  const timeline: StepMark[] = [];
  let call = 0;
  const next = (): { index: number; step: ScriptStep } => {
    const index = call;
    call += 1;
    const step = steps[index];
    if (step === undefined) throw new Error(`agent harness: model call ${index + 1} ran past the ${steps.length}-step script`);
    timeline.push({ step: index, event: 'start', at: performance.now() });
    return { index, step };
  };
  const finish = (index: number, step: ScriptStep): Pick<GenerateResult, 'finishReason' | 'usage'> => {
    timeline.push({ step: index, event: 'end', at: performance.now() });
    const unified = step.some((part) => part.type === 'tool') ? 'tool-calls' : 'stop';
    return { finishReason: { unified, raw: unified }, usage: USAGE };
  };
  const model = new MockLanguageModelV4({
    modelId: 'agent-harness',
    doStream: async () => {
      const { index, step } = next();
      const id = `t${index}`;
      return {
        stream: new ReadableStream<StreamPart>({
          start(controller): void {
            void (async (): Promise<void> => {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              let open = false;
              for (const [at, part] of step.entries()) {
                if (part.type === 'delay') await sleep(part.ms);
                else if (part.type === 'abort') {
                  abort.abort();
                  controller.error(abort.signal.reason);
                  return;
                } else if (part.type === 'error') {
                  controller.enqueue({ type: 'error', error: part.error ?? new Error(part.message) });
                  controller.close();
                  return;
                } else if (part.type === 'text') {
                  if (!open) controller.enqueue({ type: 'text-start', id });
                  open = true;
                  controller.enqueue({ type: 'text-delta', id, delta: part.text });
                } else {
                  if (open) controller.enqueue({ type: 'text-end', id });
                  open = false;
                  controller.enqueue({ type: 'tool-call', toolCallId: `call_${index}_${at}`, toolName: part.name, input: JSON.stringify(part.input ?? {}) });
                }
              }
              if (open) controller.enqueue({ type: 'text-end', id });
              controller.enqueue({ type: 'finish', ...finish(index, step) });
              controller.close();
            })();
          },
        }),
      };
    },
    doGenerate: async (): Promise<GenerateResult> => {
      const { index, step } = next();
      const content: GenerateResult['content'] = [];
      for (const [at, part] of step.entries()) {
        if (part.type === 'delay') await sleep(part.ms);
        else if (part.type === 'abort') {
          abort.abort();
          throw abort.signal.reason;
        } else if (part.type === 'error') throw part.error ?? new Error(part.message);
        else if (part.type === 'text') content.push({ type: 'text', text: part.text });
        else content.push({ type: 'tool-call', toolCallId: `call_${index}_${at}`, toolName: part.name, input: JSON.stringify(part.input ?? {}) });
      }
      return { content, ...finish(index, step), warnings: [] };
    },
  });
  const stubs: ToolSet = {};
  for (const part of steps.flat()) {
    if (part.type !== 'tool' || options.tools?.[part.name] !== undefined) continue;
    const result = part.result ?? { ok: true };
    stubs[part.name] = tool({ description: `Scripted ${part.name}.`, inputSchema: z.object({}).passthrough(), execute: async () => result });
  }
  const agent = new ToolLoopAgent({ model, instructions: 'agent harness', tools: { ...stubs, ...options.tools }, stopWhen: stepCountIs(steps.length + 1) });
  return { agent, model, abort, timeline, calls: () => call };
}
