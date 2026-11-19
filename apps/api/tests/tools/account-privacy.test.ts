import { addMember, createSpace } from '../../src/spaces/store.ts';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { accountTablesPresent, purgeAccountContent } from '../../src/account/store.ts';
import { readAccountExport } from '../../src/account/export-http.ts';
import { setToolPreference } from '../../src/tools/store.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { await closeTestDb(pg); });
it('exports only owned preferences and purges them while the auth account remains', async () => {
  const owner = await addAccount(pg);
  const other = await addAccount(pg);
  await setToolPreference(db, owner.userId, { scope: 'account', toolId: 'create_task', enabled: false });
  await setToolPreference(db, other.userId, { scope: 'account', toolId: 'create_note', enabled: false });
  const exported = await readAccountExport(db, owner.userId);
  expect(exported.tool_preferences).toMatchObject([{ scope: 'account', scope_id: owner.userId, tool_id: 'create_task', enabled: false }]);
  expect(JSON.stringify(exported.tool_preferences)).not.toContain(other.userId);
  expect(Object.keys(exported.tool_preferences[0] ?? {}).sort()).toEqual(['enabled', 'scope', 'scope_id', 'tool_id', 'updated_at']);
  await purgeAccountContent(db, owner.userId, await accountTablesPresent(db));
  expect(await withUser(db, owner.userId, tx => tx.query('select tool_id from bob.tool_preferences where owner_user_id=$1', [owner.userId]))).toEqual([]);
  expect((await readAccountExport(db, owner.userId)).tool_preferences).toEqual([]);
  expect((await readAccountExport(db, other.userId)).tool_preferences).toMatchObject([{ tool_id: 'create_note', enabled: false }]);
  // The same account can still write a preference: purge removed content, not auth.users.
  await setToolPreference(db, owner.userId, { scope: 'account', toolId: 'create_task', enabled: true });
  expect((await readAccountExport(db, owner.userId)).tool_preferences).toMatchObject([{ enabled: true }]);
});

it('preserves shared space preferences for remaining members when personal content is purged', async () => {
  const owner = await addAccount(pg);
  const member = await addAccount(pg);
  const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Shared plans' });
  await addMember(db, owner.userId, space.id, member.userId, 'member');
  await setToolPreference(db, owner.userId, { scope: 'space', scopeId: space.id, toolId: 'create_task', enabled: false });
  await purgeAccountContent(db, owner.userId, await accountTablesPresent(db));
  expect((await readAccountExport(db, member.userId)).tool_preferences).toMatchObject([{ scope: 'space', scope_id: space.id, tool_id: 'create_task', enabled: false }]);
});
