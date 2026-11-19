/**
 * Chat turn context: the shapes one web chat turn's steps share (workflows/workflow-web-chat-turn.ts and the turn/chat-*
 * step files), so no step imports the workflow back.
 * Trigger: none (types only).
 * Steps: none.
 * Outcome: the trigger's input and output ports, and the per-turn context.
 * Journal: none.
 */
import type { z } from 'zod';
import type { GameTurnState } from '../voice/game-tools.ts';
import type { Db } from '../platform/db/db.ts';
import type { StoredConversation } from '../conversations/store.ts';
import type { WebChatDeps } from '../conversations/chat-tools.ts';
import type { AppBinding, AppTurnExtension } from '../bob-apps/app-turn-extension.ts';
import type { webChatRequestSchema } from '../conversations/schemas.ts';
import type { PrepTimings } from './prep-kit.ts';

/** The installed apps reach this turn only through `appTurnTools` (AppDeps wires it); absent, the turn has no app. */
export type WebTurnDeps = WebChatDeps & { appTurnTools?: AppTurnExtension };

export interface WebCancellation { turnId: string; stop: AbortController; bound: AbortSignal; agentSignal: AbortSignal; }

/** What the trigger gives the turn: the account, the parsed body, and the request-derived values. timeZone
 *  is read before the agent is built, outside the tool try, so a failure reading it fails the turn. */
export interface WebChatTurnInput {
  userId: string;
  sessionId?: string;
  request: z.infer<typeof webChatRequestSchema>;
  timeZone: () => string;
  cancellation: WebCancellation;
  /** When the HTTP handler received the request (Date.now()), for arrival_ms. */
  receivedAt?: number;
}

/** The reader's side of the turn, so the workflow never sees Express. */
export interface WebChatOutput {
  json(status: number, body: unknown, headers?: Record<string, string>): void;
  openStream(status: number, headers: Headers): void;
  write(chunk: Buffer | string): void;
  end(): void;
  headersSent(): boolean;
  /** Fires when the reader leaves before the reply ended. */
  onDisconnect(listener: () => void): void;
}

/** Trigger-owned helpers the turn calls (they stay exported from chat-http.ts for its callers). */
export interface WebChatTurnPorts {
  boundHistoryAttachments: <T extends { parts: unknown[] }>(messages: T[]) => T[];
  createFirstTextDetector: () => (chunkText: string) => boolean;
}

export type Surface = NonNullable<z.infer<typeof webChatRequestSchema>['origin']>;
export type TurnMessage = z.infer<typeof webChatRequestSchema>['message'];

/** Everything the step functions share for one turn. */
export interface TurnCtx {
  deps: WebTurnDeps;
  db: Db;
  userId: string;
  surface: Surface;
  regenerate: boolean | undefined;
  message: TurnMessage;
  conversation: StoredConversation;
  createdTitle: string | null;
  input: WebChatTurnInput;
  out: WebChatOutput;
  ports: WebChatTurnPorts;
  traceId: string | null;
  workflowId: string;
  app: AppBinding | null;
  /** The prep window for the web v2.turn_stage_prep_completed event: its start, each step's own ms, the waits. */
  clock: { startedAt: number; timings: PrepTimings; waits: PrepTimings };
  /** The reader's message store: the stored id (null on a regenerate). Every offered tool, and the reply, wait for it. */
  stored: Promise<string | null>;
}

/** State the stream and the persister share: the reader's presence and the game this turn is in. */
export interface TurnRun { clientGone: boolean; gameTurn: GameTurnState | null; }
