import { z } from 'zod';
import type { createGmailService } from '../integrations/google-gmail-service.ts';

interface DigestMessage { threadId: string; messageId: string; subject: string; from: string; text: string }
interface Dependencies {
  gmail: Pick<ReturnType<typeof createGmailService>, 'search' | 'readThread'>;
  summarize(input: { messages: DigestMessage[]; partial: boolean; instructions?: string; summaryStyle?: 'concise' | 'detailed' }, signal: AbortSignal): Promise<{ summary: string; messageIds: string[] }>;
}
interface Input {
  instructions?: string; gmailQuery?: string; summaryStyle?: 'concise' | 'detailed';
  owner: string; googleAccountId: string; coverageStart: number; coverageEnd: number;
  signal: AbortSignal; checkActive(): Promise<void>;
}
interface Result {
  summary: string; sources: { threadId: string; messageId: string; label: string }[];
  partial: boolean; messageCount: number;
}
const summarySchema = z.object({ summary: z.string().trim().min(1).max(6000),
  messageIds: z.array(z.string().min(1).max(200)).min(1).max(200) }).strict();

async function active(input: Input): Promise<void> {
  input.signal.throwIfAborted();
  await input.checkActive();
  input.signal.throwIfAborted();
}

function boundedMessage(message: DigestMessage, remaining: number): DigestMessage | undefined {
  const metadata = { ...message, text: '' };
  const available = remaining - JSON.stringify(metadata).length - 1;
  if (available < 0) return undefined;
  // JSON escaping can expand control characters sixfold. Check the serialized
  // result, not just plaintext length, before giving provider data to the model.
  let text = message.text.slice(0, Math.min(12000, available));
  while (JSON.stringify({ ...metadata, text }).length + 1 > remaining) text = text.slice(0, Math.floor(text.length / 2));
  return { ...metadata, text };
}

interface Collection { messages: DigestMessage[]; partial: boolean; remaining: number; seen: Set<string> }
function addThread(state: Collection, thread: Awaited<ReturnType<Dependencies['gmail']['readThread']>>, input: Input): void {
  state.partial ||= thread.truncated;
  for (const message of thread.messages) {
    if (message.internalDate === null) throw new Error('routine_message_date_unavailable');
    if (message.internalDate < input.coverageStart || message.internalDate >= input.coverageEnd || state.seen.has(message.id)) continue;
    state.seen.add(message.id);
    if (!message.textAvailable) throw new Error('routine_message_text_unavailable');
    const bounded = boundedMessage({ threadId: thread.id, messageId: message.id, subject: message.subject.slice(0, 300),
      from: message.from.slice(0, 300), text: message.text }, state.remaining);
    if (!bounded) { state.partial = true; continue; }
    state.remaining -= JSON.stringify(bounded).length + 1;
    state.partial ||= message.truncated || bounded.text.length < message.text.length;
    state.messages.push(bounded);
  }
}

async function collect(deps: Dependencies, input: Input): Promise<{ messages: DigestMessage[]; partial: boolean }> {
  await active(input);
  // Gmail's search is second-granularity and "after" is exclusive. Widen its
  // lower edge, then enforce the exact durable millisecond interval ourselves.
  const query = `${input.gmailQuery ? `(${input.gmailQuery}) ` : ''}after:${Math.floor(input.coverageStart / 1000) - 1} before:${Math.ceil(input.coverageEnd / 1000)}`;
  const page = await deps.gmail.search(input.owner, input.googleAccountId, { query, maxResults: 20 }, input.signal);
  const state: Collection = { messages: [], seen: new Set(), partial: Boolean(page.nextPageToken),
    remaining: 55000 - JSON.stringify({ messages: [], partial: false, instructions: input.instructions, summaryStyle: input.summaryStyle }).length };
  for (const candidate of page.threads.slice(0, 20)) {
    await active(input);
    const thread = await deps.gmail.readThread(input.owner, input.googleAccountId, candidate.id, input.signal);
    addThread(state, thread, input);
  }
  return { messages: state.messages, partial: state.partial };
}

/** Read-only, actor-bound execution; queue ownership and persistence belong to the caller. */
export function createRoutineDigest(deps: Dependencies): (input: Input) => Promise<Result> {
  return async (input) => {
    if (!Number.isSafeInteger(input.coverageStart) || !Number.isSafeInteger(input.coverageEnd)
      || input.coverageStart < 1000 || input.coverageEnd <= input.coverageStart) throw new Error('routine_interval_invalid');
    const collected = await collect(deps, input);
    await active(input);
    if (!collected.messages.length) return { summary: collected.partial
      ? 'No messages in this time window were available in the portion of your inbox checked.'
      : 'No matching messages were found in this time window.', sources: [], partial: collected.partial, messageCount: 0 };
    const parsed = summarySchema.safeParse(await deps.summarize({ ...collected, instructions: input.instructions, summaryStyle: input.summaryStyle }, input.signal));
    await active(input);
    if (!parsed.success) throw new Error('routine_summary_invalid');
    const ids = new Set(parsed.data.messageIds);
    if (ids.size !== parsed.data.messageIds.length || [...ids].some(id => !collected.messages.some(message => message.messageId === id))) {
      throw new Error('routine_summary_invalid');
    }
    return { summary: parsed.data.summary, partial: collected.partial, messageCount: collected.messages.length,
      sources: collected.messages.filter(message => ids.has(message.messageId)).map(message => ({
        threadId: message.threadId, messageId: message.messageId, label: message.subject || 'Email',
      })) };
  };
}
