import type { Tool } from 'ai';
import type { Db } from '../platform/db/db.ts';
import type { ToolContext } from './schemas.ts';
import { getEffectiveTools } from './store.ts';

export class ToolPolicyError extends Error {
  constructor(readonly code: 'tool_disabled' | 'tool_policy_unavailable') { super(code); this.name = 'ToolPolicyError'; }
}
/** A fresh policy read never replaces the capability, OAuth or scope guard. */
export async function assertToolEnabled(db: Db, userId: string, toolId: string, context: ToolContext = {}): Promise<void> {
  let enabled = false;
  try {
    enabled = (await getEffectiveTools(db, userId, context)).tools.some((tool) => tool.id === toolId && tool.enabled);
  } catch { throw new ToolPolicyError('tool_policy_unavailable'); }
  if (!enabled) throw new ToolPolicyError('tool_disabled');
}
/** Prepare once for the offered map; captured executions always recheck storage. */
export async function prepareToolPolicyFilter(db: Db, userId: string, context: ToolContext = {}): Promise<(tools: Record<string, Tool>) => Record<string, Tool>> {
  const result = await getEffectiveTools(db, userId, context);
  const allowed = new Set(result.tools.filter((tool) => tool.enabled).map((tool) => tool.id));
  return (tools) => Object.fromEntries(Object.entries(tools).filter(([id]) => allowed.has(id)).map(([id, definition]) => {
    const execute = definition.execute;
    if (!execute) return [id, definition];
    return [id, { ...definition, execute: async (input: unknown, options: Parameters<NonNullable<Tool['execute']>>[1]) => {
      await assertToolEnabled(db, userId, id, context);
      return execute(input, options);
    } }];
  }));
}
