import { openSpan, toSpanAttrs, withCorrelation } from '@bob/ai';
import type { SessionDto } from '../protocol.ts';

/**
 * The one long-lived `device-turn` root span of a device turn, opened at
 * turn_start and ended exactly once when the turn ends. Every span of the turn
 * (controls, uplink, pipeline) runs through `run` and so descends from it.
 */
export interface TurnRoot {
  readonly turnRef: string;
  run<T>(fn: () => T): T;
  /** Ends the root once; `failed` (or an earlier markTurnFailed) sets ERROR. */
  end(failed?: boolean): void;
}

interface OpenRoot extends TurnRoot {
  fail(): void;
}

const roots = new WeakMap<SessionDto, OpenRoot>();

export interface TurnRootAttrs {
  turnRef: string;
  /** The client session: the WebSocket session id (`session.id`). */
  sessionId: string;
  /** The canonical conversation id (`bob.conversation.id` and `gen_ai.conversation.id`), when known. */
  conversationId?: string;
  /** The paired account; omitted when unpaired. */
  userId?: string;
}

/** Opens the root for a turn, ending a leaked one first. */
export function openTurnRoot(session: SessionDto, attrs: TurnRootAttrs): TurnRoot {
  roots.get(session)?.end();
  const span = openSpan('device-turn', {
    ...toSpanAttrs({
      surface: 'device', workflowNamespace: session.id, turnId: attrs.turnRef,
      sessionId: attrs.sessionId,
      ...(attrs.conversationId !== undefined ? { conversationId: attrs.conversationId, conversationSource: 'device' as const } : {}),
      ...(attrs.userId !== undefined ? { userId: attrs.userId } : {}),
    }),
    traceName: 'device-turn',
  });
  let failed = false;
  let done = false;
  const root: OpenRoot = {
    turnRef: attrs.turnRef,
    run: span.run,
    fail(): void { failed = true; },
    end(markFailed = false): void {
      if (done) return;
      done = true;
      if (roots.get(session) === root) roots.delete(session);
      span.end(failed || markFailed);
    },
  };
  roots.set(session, root);
  return root;
}

export function turnRootOf(session: SessionDto): TurnRoot | undefined {
  return roots.get(session);
}

/** Runs `fn` inside the session's open root (when it is for `turnRef`, if given), else bare. */
export function runInTurnRoot<T>(session: SessionDto, turnRef: string | undefined, fn: () => T): T {
  const root = roots.get(session);
  return root !== undefined && (turnRef === undefined || root.turnRef === turnRef) ? root.run(fn) : fn();
}

export function closeTurnRoot(session: SessionDto, failed = false): void {
  roots.get(session)?.end(failed);
}

/** A failed pipeline stage: the root will end with ERROR / workflow_failed. */
export function markTurnFailed(session: SessionDto): void {
  roots.get(session)?.fail();
}

/** Late conversation: the active conversation resolves at turn_start, after the root opened. */
export function setTurnRootConversation(session: SessionDto, conversationId: string): void {
  roots.get(session)?.run(() => withCorrelation({ conversationId, conversationSource: 'device' }, () => undefined));
}
