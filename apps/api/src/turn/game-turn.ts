/**
 * Device game turn: what a device turn in a game does around its model run.
 * Trigger: turn/device-agent.ts (scope, prewarm) and voice/turn/generate.ts generateReply (hold, guard).
 * Steps: 1. read the game this turn is in; an ACTIVE game prewarms its preview lines. 2. close, once a game opens
 *   mid-turn, what an active game would not have offered. 3. hold the streamed rest once a game opened. 4. guard the
 *   reply (or its held rest) after the tool gate, before TTS, reply_text and the save.
 * Outcome: the game's tool closing, the stream hold, and the reply text the turn speaks and stores.
 * Journal: v2.game_guard_replaced (voice/game-tools.ts guardGameReply, through the caller's journal).
 */
import type { Tool } from 'ai';
import { guardGameReply, type GameTurnState } from '../voice/game-tools.ts';
import type { SessionDto } from '../voice/protocol.ts';
import type { StreamedAgentResult } from '../voice/turn/agent.ts';
import type { TurnDeps } from '../voice/turn/deps.ts';
import { prewarmSpeech } from './speech-prewarm.ts';
import type { TurnCapabilities } from '../voice/turn/tools.ts';
import { closeOnceGameOpens } from './tool-wiring.ts';

type GuardJournal = Parameters<typeof guardGameReply>[2];

/** The game this device turn is in, and how its tools close. */
export interface DeviceGameTurn {
  gameTurn: GameTurnState | null;
  gameActive: boolean;
  close: (tools: Record<string, Tool>) => Record<string, Tool>;
}

/** Reads the game from the turn's capabilities; an ACTIVE game prewarms the speech of its preview lines. The tool set
 *  is chosen before the model runs; a game opened mid-turn closes what an active game would not have offered. */
export function deviceGameTurn(
  deps: TurnDeps, session: SessionDto, turnRef: string, capabilities: TurnCapabilities, signal?: AbortSignal,
): DeviceGameTurn {
  const gameTurn = capabilities.game?.turn ?? null;
  const gameActive = capabilities.game?.mode === 'active';
  if (gameActive && gameTurn !== null) prewarmSpeech(deps, session, turnRef, Object.values(gameTurn.preview), signal);
  return { gameTurn, gameActive, close: closeOnceGameOpens(capabilities.game) };
}

/** Decided before the model runs; a game tool that opens a game mid-turn flips gameTurn.gameTurn, and the rest is then held. */
export function holdOnceGameOpens(gameTurn: GameTurnState | null): () => boolean {
  return () => gameTurn?.gameTurn === true;
}

/** A game reply is guarded before TTS, reply_text and the save; a streamed reply whose game opened mid-turn guards only
 *  the held rest. The guard runs game tools and moves the round on: it waits for the tool gate first (the anchor write,
 *  or a speculative commit). */
export async function guardDeviceReply(
  result: StreamedAgentResult, gameTurn: GameTurnState, toolGate: Promise<void> | undefined, journal: GuardJournal,
): Promise<{ replyText: string; heldTail?: string }> {
  await toolGate;
  const heldTail = result.heldText !== undefined ? await guardGameReply(result.heldText, gameTurn, journal) : undefined;
  const replyText = heldTail !== undefined
    ? [result.spokenText ?? '', heldTail].filter((part) => part !== '').join(' ')
    : await guardGameReply(result.text, gameTurn, journal);
  return { replyText, ...(heldTail !== undefined ? { heldTail } : {}) };
}
