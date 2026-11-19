import { StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { TOOL_CATALOG, isKnownTool } from './catalog.ts';
import { ToolContextSchema, ToolPreferenceSchema, type ToolCatalogResponse, type ToolContext, type ToolPreference, type ToolScopeRef } from './schemas.ts';

interface Resolved { scopes: ToolScopeRef[]; selected: ToolScopeRef; canEdit: boolean; shared: boolean }
interface PreferenceRow { scope: ToolScopeRef['scope']; scope_id: string; tool_id: string; enabled: boolean }
function checkMatchingSpace(requested: string | undefined, actual: string): void {
  if (requested && requested !== actual) throw new StoreNotFoundError('tool_scope_not_found');
}
async function resolveScopes(tx: Db, userId: string, context: ToolContext): Promise<Resolved> {
  const scopes: ToolScopeRef[] = [{ scope: 'account', scopeId: userId }];
  let spaceId = context.spaceId;
  let conversation: { user_id: string; space_id: string } | undefined;
  if (context.conversationId) {
    [conversation] = await tx.query<{ user_id: string; space_id: string }>('select user_id,space_id from bob.conversations where id=$1 and archived_at is null', [context.conversationId]);
    if (!conversation) throw new StoreNotFoundError('tool_scope_not_found');
    checkMatchingSpace(spaceId, conversation.space_id);
    spaceId = conversation.space_id;
  }
  let canEdit = true;
  let shared = false;
  if (spaceId) {
    const [space] = await tx.query<{ kind: string; can_edit: boolean }>('select kind,bob_private.is_space_owner_or_admin(id) as can_edit from bob.spaces where id=$1 and archived_at is null and bob_private.is_space_member(id)', [spaceId]);
    if (!space) throw new StoreNotFoundError('tool_scope_not_found');
    shared = space.kind !== 'private';
    canEdit = space.can_edit;
    scopes.push({ scope: 'space', scopeId: spaceId });
  }
  if (context.conversationId && conversation) {
    canEdit = canEdit || conversation.user_id === userId;
    scopes.push({ scope: 'conversation', scopeId: context.conversationId });
  }
  if (context.integrationId) {
    const [account] = await tx.query<{ id: string }>('select id from bob.google_accounts where id=$1 and user_id=$2', [context.integrationId, userId]);
    if (!account || shared) throw new StoreNotFoundError('tool_scope_not_found');
    scopes.push({ scope: 'integration', scopeId: account.id });
    canEdit = true;
  }
  const selected = scopes.at(-1);
  if (!selected) throw new StoreNotFoundError('tool_scope_not_found');
  return { scopes, selected, canEdit, shared };
}
async function loadPreferences(tx: Db, scopes: ToolScopeRef[]): Promise<PreferenceRow[]> {
  return tx.query<PreferenceRow>('select scope,scope_id,tool_id,enabled from bob.tool_preferences where (scope,scope_id) in (select scope, "scopeId" from jsonb_to_recordset($1::text::jsonb) as refs(scope text,"scopeId" text))', [JSON.stringify(scopes)]);
}
export async function getEffectiveTools(db: Db, userId: string, input: ToolContext = {}): Promise<ToolCatalogResponse> {
  const context = ToolContextSchema.parse(input);
  return withUser(db, userId, async (tx) => {
    const resolved = await resolveScopes(tx, userId, context);
    const preferences = await loadPreferences(tx, resolved.scopes);
    const catalog = context.integrationId ? TOOL_CATALOG.filter((tool) => tool.integrationKind === 'google' && tool.id !== 'google_list_accounts') : TOOL_CATALOG;
    return { scope: resolved.selected, canEdit: resolved.canEdit, tools: catalog.map((tool) => {
      const rows = preferences.filter((row) => row.tool_id === tool.id);
      const blockedBy = rows.filter((row) => !row.enabled).map((row) => ({ scope: row.scope, scopeId: row.scope_id }));
      const preference = rows.find((row) => row.scope === resolved.selected.scope && row.scope_id === resolved.selected.scopeId)?.enabled ?? null;
      const unavailable = resolved.shared && tool.integrationKind === 'google';
      return { ...tool, preference, blockedBy, enabled: blockedBy.length === 0 && !unavailable, availability: unavailable ? 'unavailable' as const : 'context_dependent' as const };
    }) };
  });
}
function preferenceContext(userId: string, input: ToolPreference): ToolContext {
  if (input.scope === 'account') {
    if (input.scopeId && input.scopeId !== userId) throw new StoreNotFoundError('tool_scope_not_found');
    return {};
  }
  if (!input.scopeId) throw new StoreNotFoundError('tool_scope_not_found');
  if (input.scope === 'integration') return { integrationId: input.scopeId };
  if (input.scope === 'space') return { spaceId: input.scopeId };
  return { conversationId: input.scopeId };
}
export async function setToolPreference(db: Db, userId: string, raw: ToolPreference): Promise<ToolCatalogResponse> {
  const input = ToolPreferenceSchema.parse(raw);
  if (!isKnownTool(input.toolId)) throw new StoreNotFoundError('tool_not_found');
  const context = ToolContextSchema.parse(preferenceContext(userId, input));
  if (context.integrationId && (!input.toolId.startsWith('google_') || input.toolId === 'google_list_accounts')) throw new StoreNotFoundError('tool_not_found');
  await withUser(db, userId, async (tx) => {
    const { selected, canEdit } = await resolveScopes(tx, userId, context);
    if (!canEdit) throw new StoreNotFoundError('tool_scope_not_found');
    if (input.enabled === null) {
      await tx.query('delete from bob.tool_preferences where scope=$1 and scope_id=$2 and tool_id=$3', [selected.scope, selected.scopeId, input.toolId]);
      return;
    }
    await tx.query(`insert into bob.tool_preferences(scope,scope_id,tool_id,enabled,owner_user_id,integration_id,space_id,conversation_id)
      values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(scope,scope_id,tool_id) do update set enabled=excluded.enabled,updated_at=now()`,
      [selected.scope,selected.scopeId,input.toolId,input.enabled, ['account','integration'].includes(selected.scope) ? userId : null,
        context.integrationId ?? null, input.scope === 'space' ? context.spaceId : null, context.conversationId ?? null]);
  });
  return getEffectiveTools(db, userId, context);
}
