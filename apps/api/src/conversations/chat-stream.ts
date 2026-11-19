/** Streaming helpers of the web chat turn: the trace, message text length and the game-reply stream gate. */
import { randomUUID } from 'node:crypto';
import { traceSpan, toSpanAttrs, workflowTraceId } from '@bob/ai';
import { telemetryConversationId } from '../platform/observability/conversation-correlation.ts';

/**
 * One trace per web turn, carrying the canonical conversation and the acting user (the client
 * session comes from the request) and tagged by surface. Each attempt gets a fresh namespace: regeneration
 * reuses the user message id for Stop/journal correlation, not trace identity.
 */
export async function traceWebTurn<T>(conversationId: string, userId: string, turnId: string, run: (traceId: string | null) => T | Promise<T>, workflowId?: string): Promise<T> {
  const attrs = toSpanAttrs({
    surface: 'web', turnId, workflowNamespace: workflowId ? `web-voice/${userId}` : randomUUID(),
    workflowId, conversationId: telemetryConversationId(conversationId), conversationSource: 'explicit', userId, metadata: { interface: 'web' },
  });
  const traceId = await workflowTraceId(attrs);
  return traceSpan('web-chat-turn', attrs, () => run(traceId));
}

/** Characters of a message's text parts: a length, never the text. */
export function textChars(parts: unknown): number {
  if (!Array.isArray(parts)) return 0;
  return parts.reduce((total: number, part: unknown) => {
    const text = (part as { type?: unknown; text?: unknown } | null)?.text;
    return typeof text === 'string' ? total + text.length : total;
  }, 0);
}

type SsePart = { type?: unknown; id?: unknown; delta?: unknown };

/** One SSE event's JSON part; null for the [DONE] marker or anything else. */
function ssePart(event: string): SsePart | null {
  const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
  if (data === '' || data === '[DONE]') return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null ? parsed as SsePart : null;
  } catch {
    return null;
  }
}

interface GameStreamGate {
  /** The SSE text to send for an upstream chunk; null sends the chunk's bytes as they are. */
  push: (chunk: string) => Promise<string | null>;
  /** What is still held, checked, when the stream ends. */
  end: () => Promise<string>;
}

const TEXT_PARTS: readonly unknown[] = ['text-start', 'text-delta', 'text-end'];

/**
 * In a game turn (a game active at the start, or started during it) the
 * model's text is held and sent only once `check` (guardGameReply, shared
 * with the saved copy) has passed or replaced it, so
 * the reader never sees a line the server did not keep. Other events stream
 * as they come; until a game is in play the upstream bytes pass unchanged.
 */
export function createGameStreamGate(inGame: () => boolean, check: (text: string) => Promise<string>): GameStreamGate {
  let gated = false;
  let buffer = '';
  let sent = 0;
  let streamedText = '';
  let fullText = '';
  let released = false;
  const heldIds = new Set<string>();
  const held: string[] = [];
  const event = (part: Record<string, unknown>): string => `data: ${JSON.stringify(part)}\n\n`;
  const release = async (): Promise<string> => {
    if (released || held.length === 0) return '';
    released = true;
    const checked = await check(fullText);
    if (checked === fullText) return held.join('');
    const text = checked.startsWith(streamedText) ? checked.slice(streamedText.length) : checked;
    if (text === '') return '';
    const id = 'game-guard';
    return event({ type: 'text-start', id }) + event({ type: 'text-delta', id, delta: text }) + event({ type: 'text-end', id });
  };
  return {
    push: async (chunk) => {
      buffer += chunk;
      // The buffer's head before this chunk already went out as bytes.
      if (!gated && inGame()) { gated = true; sent = buffer.length - chunk.length; }
      let out = '';
      for (let cut = buffer.indexOf('\n\n'); cut !== -1; cut = buffer.indexOf('\n\n')) {
        const raw = buffer.slice(0, cut + 2);
        buffer = buffer.slice(cut + 2);
        const written = Math.min(sent, raw.length);
        sent -= written;
        const part = ssePart(raw);
        const id = String(part?.id ?? '');
        if (gated && part?.type === 'text-start') heldIds.add(id);
        const isHeld = TEXT_PARTS.includes(part?.type) && heldIds.has(id);
        if (part?.type === 'text-delta' && typeof part.delta === 'string') {
          fullText += part.delta;
          if (!isHeld) streamedText += part.delta;
        }
        if (!gated) continue;
        if (isHeld) { held.push(raw); continue; }
        if (part?.type === 'finish' || part?.type === 'error') out += await release();
        out += raw.slice(written);
      }
      return gated ? out : null;
    },
    end: async () => {
      if (!gated) return '';
      const tail = (await release()) + buffer.slice(sent);
      buffer = '';
      return tail;
    },
  };
}

