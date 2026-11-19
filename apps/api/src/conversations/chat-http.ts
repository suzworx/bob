import type { Request, Response as ExpressResponse } from 'express';
import { randomUUID } from 'node:crypto';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { z } from 'zod';
import { accountTimeZone } from '../account/auth.ts';
import { attachmentBytes, webChatRequestSchema } from '../web-schemas.ts';
import { runWebChatTurn, type WebCancellation, type WebChatOutput } from '../workflows/workflow-web-chat-turn.ts';
import { type WebChatDeps } from './chat-tools.ts';

/**
 * Decoded attachment bytes replayed to the provider in one turn. The
 * per-message bound alone does not bound a turn: 40 remembered messages each
 * carrying the 8 MiB a message may hold is 320 MiB re-read from the store and
 * re-uploaded on every single turn. This is the same kind of bound as
 * MAX_HISTORY_MESSAGES -- older content falls out of what the model is shown,
 * while the store keeps all of it and the reader still sees all of it.
 */
export const MAX_HISTORY_ATTACHMENT_BYTES = 16 * 1024 * 1024;

/**
 * Images replayed to the provider in one turn. The provider bills an
 * image per tile, not per byte (~765 tokens for a typical photo at high/auto
 * detail), so the byte budget alone admits anything from 4 large photos to ~80
 * small ones. Four images cap the replay tail at ~3,060 tokens. With the 4 MiB
 * per-attachment cap the byte budget can no longer bind; it stays as a
 * secondary bound. Set to Infinity to restore the pure byte budget.
 */
export const MAX_HISTORY_ATTACHMENTS = 4;

/**
 * Drops file parts from the OLDEST messages once the replay budget -- count
 * AND bytes -- is spent, newest-first, so the most recent attachments (the
 * current message's first) are the ones the model sees.
 * Text is never dropped; a message left with no parts at all is removed,
 * because an empty parts array is not a valid UI message.
 */
export function boundHistoryAttachments<T extends { parts: unknown[] }>(
  messages: T[],
  budget: number = MAX_HISTORY_ATTACHMENT_BYTES,
  maxCount: number = MAX_HISTORY_ATTACHMENTS,
): T[] {
  let remaining = budget;
  let slots = maxCount;
  const kept: T[] = [];
  for (const message of [...messages].reverse()) {
    const parts = message.parts.filter((part) => {
      const bytes = attachmentBytes(part);
      if (bytes === 0) return true;
      if (slots <= 0 || bytes > remaining) return false;
      remaining -= bytes;
      slots -= 1;
      return true;
    });
    if (parts.length === 0) continue;
    kept.push(parts.length === message.parts.length ? message : { ...message, parts });
  }
  return kept.reverse();
}


/**
 * The hard bound on one web turn, which does not end when the reader leaves. BOB_MAX_AGENT_STEPS model
 * calls plus their tools finish well inside this on a healthy provider; past it the turn is aborted and
 * journalled timed_out, so a detached turn can never run on unwatched.
 */
const WEB_TURN_TIMEOUT_MS = 120_000;

// In-flight web turns by account and client message id, so an explicit Stop can still cancel a turn that a
// closed tab no longer does.
const liveTurns = new Map<string, AbortController>();
const liveTurnKey = (userId: string, turnId: string): string => `${userId}:${turnId}`;

export const stopRequestSchema = z.object({ messageId: z.string().min(1).max(128) });

/** POST body { messageId }: cancels that account's in-flight turn, if any. */
export function webChatStop(request: Request, response: ExpressResponse): void {
  const parsed = stopRequestSchema.safeParse(request.body);
  if (!parsed.success) { response.status(400).json({ error: { code: 'invalid_request' } }); return; }
  const userId = request.account?.userId;
  if (!userId) { response.status(401).json({ error: { code: 'invalid_token' } }); return; }
  const controller = liveTurns.get(liveTurnKey(userId, parsed.data.messageId));
  controller?.abort(new DOMException('Stopped by the reader', 'AbortError'));
  response.status(200).json({ stopped: controller !== undefined });
}

/** Detects the first `"type":"text-delta"` SSE part in a turn's byte stream (true time-to-first-token, not
 *  the stream's `start`). A marker split across two reads is still caught by keeping the last TAIL_CHARS of
 *  the previous chunk, longer than the marker, instead of the whole reply so far. */
const FIRST_TEXT_MARKER = '"type":"text-delta"';
const TAIL_CHARS = 32;

export function createFirstTextDetector(): (chunkText: string) => boolean {
  let tail = '';
  let seen = false;
  return (chunkText: string): boolean => {
    if (!seen && (tail + chunkText).includes(FIRST_TEXT_MARKER)) seen = true;
    tail = chunkText.slice(-TAIL_CHARS);
    return seen;
  };
}


async function sendSystemTestResponse(response: ExpressResponse): Promise<void> {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: 'data-stub', data: { source: 'system-test' } } as never);
      writer.write({ type: 'text-start', id: 'system-test' });
      writer.write({ type: 'text-delta', id: 'system-test', delta: 'System test response' });
      writer.write({ type: 'text-end', id: 'system-test' });
    },
  });
  const upstream = createUIMessageStreamResponse({ stream });

  response.status(upstream.status);
  upstream.headers.forEach((value, key) => response.setHeader(key, value));
  if (!upstream.body) { response.end(); return; }
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      response.write(Buffer.from(chunk.value));
    }
  } finally { reader.releaseLock(); }
  response.end();
}


/** The Express response as the turn's output: the workflow never sees Express. */
function responseOutput(response: ExpressResponse): WebChatOutput {
  return {
    json: (status, body, headers) => {
      for (const [name, value] of Object.entries(headers ?? {})) response.setHeader(name, value);
      response.status(status).json(body);
    },
    openStream: (status, headers) => {
      response.status(status);
      headers.forEach((value, key) => response.setHeader(key, value));
    },
    write: (chunk) => { response.write(chunk); },
    end: () => { response.end(); },
    headersSent: () => response.headersSent,
    onDisconnect: (listener) => { response.on('close', () => { if (!response.writableEnded) listener(); }); },
  };
}

async function webChatHandler(deps: WebChatDeps, request: Request, response: ExpressResponse, cancellation: WebCancellation, receivedAt: number): Promise<void> {
  const parsed = webChatRequestSchema.safeParse(request.body);
  if (!parsed.success) { response.status(400).json({ error: { code: 'invalid_request', details: parsed.error.flatten() } }); return; }
  // The canned stub never touches the store; scripted test agents run the real pipeline.
  if (deps.agent.kind === 'stub') {
    await sendSystemTestResponse(response);
    return;
  }

  const userId = request.account?.userId;
  if (!userId) { response.status(401).json({ error: { code: 'invalid_token' } }); return; }
  await runWebChatTurn(
    deps,
    { userId, ...(request.account?.sessionId ? { sessionId: request.account.sessionId } : {}), request: parsed.data, timeZone: () => accountTimeZone(request), cancellation, receivedAt },
    responseOutput(response),
    { boundHistoryAttachments, createFirstTextDetector },
  );
}

export const webChat = (deps: WebChatDeps) => async (request: Request, response: ExpressResponse): Promise<void> => {
  // The whole wait (arrival_ms) starts here, before parsing, the conversation lookup and the history load.
  const receivedAt = Date.now();
  const parsed = webChatRequestSchema.safeParse(request.body);
  const turnId = parsed.success ? parsed.data.message.id ?? randomUUID() : randomUUID();
  const stop = new AbortController();
  const bound = AbortSignal.timeout(WEB_TURN_TIMEOUT_MS);
  const agentSignal = AbortSignal.any([stop.signal, bound]);
  const liveKey = liveTurnKey(request.account?.userId ?? '', turnId);
  liveTurns.set(liveKey, stop);
  try {
    await webChatHandler(deps, request, response, { turnId, stop, bound, agentSignal }, receivedAt);
  } finally {
    if (liveTurns.get(liveKey) === stop) liveTurns.delete(liveKey);
  }
};
