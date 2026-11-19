import type { ChatAppBinding } from '../conversations/schemas.ts';
import { StoreError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { requireAppAccess } from './app-access.ts';
import { authorizeMarketingInvocation, preflightMarketingTurn } from './marketing-turn.ts';
import { requireMarketingSession } from './marketing-install.ts';

export async function requireBoundAppSession(tx: Db, sessionId?: string): Promise<void> {
  if (!sessionId) throw new StoreError('app_session_inactive');
  await requireMarketingSession(tx, sessionId);
}

/** The installation discriminator is stored authority, never a client agent choice. */
export async function genericAppId(tx: Db, installationId: string): Promise<string | null> {
  const [row] = await tx.query<{ app_id: string; kind: string }>('select app_id,kind from bob.bob_app_installations where id=$1', [installationId]);
  if (!row) throw new StoreNotFoundError('app_binding_unavailable');
  return row.kind === 'generic' ? row.app_id : null;
}

export async function authorizeGenericApp(tx: Db, actor: string, binding: ChatAppBinding, conversationId?: string, sourceId?: string): Promise<{ appId: string; spaceId: string | null; conversationSpaceId: string | null }> {
  if (binding.mode !== 'refine' || binding.channel !== undefined || binding.campaignId !== undefined || binding.intent !== undefined) throw new StoreNotFoundError('app_binding_unavailable');
  const appId = await genericAppId(tx, binding.installationId);
  if (!appId) throw new StoreNotFoundError('app_binding_unavailable');
  const audience = await requireAppAccess(tx, actor, appId, 'write', true);
  const [live] = await tx.query('select a.id from bob.bob_apps a join bob.bob_app_installations i on i.app_id=a.id where a.id=$1 and a.lifecycle in (\'draft\',\'active\') and i.state in (\'draft\',\'active\')', [appId]);
  if (!live) throw new StoreNotFoundError('app_binding_unavailable');
  let conversationSpaceId: string | null = null;
  if (conversationId) {
    const [conversation] = await tx.query<{ space_id: string }>(`select c.space_id from bob.conversations c join bob.spaces s on s.id=c.space_id
      where c.id=$1 and c.archived_at is null and s.archived_at is null
      and (($2::uuid is null and s.kind='private' and s.owner_user_id=$3 and c.user_id=$3)
        or ($2::uuid is not null and c.space_id=$2 and s.kind='group' and s.conversation_id is null))`, [conversationId, audience.spaceId, actor]);
    if (!conversation) throw new StoreNotFoundError('app_binding_unavailable');
    conversationSpaceId = conversation.space_id;
  }
  if (sourceId) {
    const [source] = await tx.query(`select id from bob.messages where id=$1 and conversation_id=$2 and author_user_id=$3 and role='user' and tombstoned_at is null for share`, [sourceId, conversationId, actor]);
    if (!source) throw new StoreNotFoundError('app_source_unavailable');
  }
  return { appId, spaceId: audience.spaceId, conversationSpaceId };
}

/** Called under the claim/reply transaction, before even a duplicate receipt is exposed. */
export async function authorizeAppInvocation(tx: Db, actor: string, binding: ChatAppBinding, conversationId: string, sessionId?: string, sourceId?: string): Promise<void> {
  if (!await genericAppId(tx, binding.installationId)) return authorizeMarketingInvocation(tx, actor, binding, conversationId);
  if (!sourceId) throw new StoreNotFoundError('app_source_unavailable');
  const audience = await authorizeGenericApp(tx, actor, binding, conversationId, sourceId);
  if (!audience.spaceId) throw new StoreNotFoundError('app_binding_unavailable');
  await requireBoundAppSession(tx, sessionId);
}

/** Private admission precedes creating messages and reading personal context. */
export async function preflightAppTurn(db: Db, actor: string, binding?: ChatAppBinding, conversationId?: string, sessionId?: string): Promise<{ binding: ChatAppBinding | null; generic: boolean }> {
  if (binding && await withUser(db, actor, (tx) => genericAppId(tx, binding.installationId))) {
    await withUser(db, actor, async (tx) => {
      const audience = await authorizeGenericApp(tx, actor, binding, conversationId);
      if (audience.spaceId) throw new StoreNotFoundError('app_binding_unavailable');
      await requireBoundAppSession(tx, sessionId);
    });
    return { binding: { ...binding }, generic: true };
  }
  return { binding: await preflightMarketingTurn(db, actor, binding, conversationId), generic: false };
}
