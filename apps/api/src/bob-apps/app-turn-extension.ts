/**
 * The one extension point through which an installed Bob app reaches a turn (spec 015 U1, plan "Contract:
 * internal seams" part 2). The device turn, the web chat turn and thread invocations ask it for the app's
 * admission and tools; none of them names an app. Marketing (and the generic bound declarative app) is the
 * only implementation, wired once in app-deps.ts as `appTurnTools`.
 */
import type { Tool } from 'ai';
import { marketingTaskContext as marketingTaskLines, marketingToolNames, type CoreTaskContext } from '@bob/ai';
import type { ChatAppBinding } from '../conversations/schemas.ts';
import { withUser, type Db } from '../platform/db/db.ts';
import { genericAppId, preflightAppTurn } from './bound-app-turn.ts';
import { createBoundAppTools, type SaveAppIdea } from './bound-app-tools.ts';
import { MarketingPausedError, marketingTaskContext, marketingToolsForTurn } from './marketing-turn.ts';

/** The persisted, owner-authored user message the app's tools write against. */
interface AppAnchor { conversationId: string; messageId: string }

/** A turn's app tools, plus the fixed task guidance they admit. */
export interface AppTurnTools {
  tools: Record<string, Tool>;
  taskContext?: CoreTaskContext;
  /** The names whose permitted presence enables `taskContext` (CreateBobAgentOptions.contextToolNames). */
  contextToolNames: string[];
}

/** A server-admitted app scope for one turn; never client JSON. `generic` is the stored installation kind. */
export interface AppBinding { binding: ChatAppBinding; generic: boolean; sessionId?: string }

/** Why an explicit binding was refused, as the web answers it. */
interface AppRefusal { status: 404 | 409; body: { error: { code: string; message: string } } }

export interface AppTurnExtension {
  /** Private admission before any message is written: the explicit binding (refusals throw), else the owner's
   *  default app for this conversation; null when the turn has no app. */
  preflight(db: Db, userId: string, conversationId: string | undefined, request?: { appBinding?: ChatAppBinding; sessionId?: string }): Promise<AppBinding | null>;
  /** A thread invocation's stored binding, already authorized under the claim. */
  bind(db: Db, userId: string, binding: ChatAppBinding, sessionId?: string): Promise<AppBinding>;
  /** The app's tools on a persisted anchor; empty without a binding or anchor. */
  tools(db: Db, userId: string, app: AppBinding | null, anchor: AppAnchor | null): Promise<AppTurnTools>;
  /** The web answer for a refused preflight. */
  refusal(cause: unknown): AppRefusal;
}

const NONE: AppTurnTools = { tools: {}, contextToolNames: [] };

/** The Bob apps extension: the generic bound declarative app and Marketing. `saveAppIdea` is the workflow's
 *  idea writer, injected so this module never imports a workflow. */
export function createAppTurnExtension(saveAppIdea: SaveAppIdea): AppTurnExtension {
  return {
    async preflight(db, userId, conversationId, request) {
      const admitted = await preflightAppTurn(db, userId, request?.appBinding, conversationId, request?.sessionId);
      if (!admitted.binding) return null;
      return { binding: admitted.binding, generic: admitted.generic, ...(request?.sessionId ? { sessionId: request.sessionId } : {}) };
    },
    async bind(db, userId, binding, sessionId) {
      const generic = Boolean(await withUser(db, userId, (tx) => genericAppId(tx, binding.installationId)));
      return { binding, generic, ...(sessionId ? { sessionId } : {}) };
    },
    async tools(db, userId, app, anchor) {
      if (!app) return NONE;
      if (app.generic) {
        if (!anchor) return NONE;
        const context = { db, actor: userId, binding: app.binding, conversationId: anchor.conversationId, sourceId: anchor.messageId, sessionId: app.sessionId };
        return { tools: createBoundAppTools(context, saveAppIdea), contextToolNames: [] };
      }
      const tools = await marketingToolsForTurn(db, userId, app.binding, anchor?.conversationId ?? '', anchor?.messageId ?? null);
      const intent = marketingTaskContext(app.binding, tools)?.intent;
      return { tools, contextToolNames: [...marketingToolNames], ...(intent ? { taskContext: marketingTaskLines(intent) } : {}) };
    },
    refusal(cause) {
      return cause instanceof MarketingPausedError
        ? { status: 409, body: { error: { code: 'app_paused', message: 'Marketing is paused. Resume it to keep going; your text is still here.' } } }
        : { status: 404, body: { error: { code: 'not_found', message: 'That app is no longer available. Open My Apps to choose an active app.' } } };
    },
  };
}
