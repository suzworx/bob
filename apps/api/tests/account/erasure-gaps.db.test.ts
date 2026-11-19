// test:db suite (#513): every bob.* column that references auth.users is
// handled by account erasure. Reads the foreign keys from the catalog of a
// database built from THIS checkout's migrations (support/test-db.ts), so a new
// table that names a user fails here until its erasure path is declared AND
// proven: the declared definer's body must touch that table and column, a
// store purge must name the table, or the row must cascade from a purged
// parent. A declared column the catalog no longer has fails too, so the map
// never goes stale. Skips cleanly when the local stack's Postgres port does
// not answer.
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/platform/db/db.ts';

const DB_PORT = Number(process.env.BOB_TEST_DB_PORT ?? 54322);

function stackAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (up: boolean): void => { socket.destroy(); resolve(up); };
    socket.setTimeout(1500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const stackUp = await stackAnswers(DB_PORT);

/** How erasure handles a column: inside a named bob_private definer, by a
 *  store purge that deletes the table (store/account.ts), or by an on delete
 *  cascade from a parent table that is itself handled. */
type Handler =
  | {
    definer:
      | 'erase_account(uuid,timestamptz)'
      | 'purge_account_notifications(uuid)'
      | 'purge_account_games(uuid)'
      | 'purge_account_email_effects(uuid)'
      | 'purge_account_push(uuid)'
      | 'purge_account_google_native(uuid)'
      | 'purge_account_scopes(uuid)'
      | 'purge_account_group_chats(uuid)'
      | 'purge_bob_apps(uuid)';
  }
  | { storePurge: 'store/account.ts' }
  | { explicitStorePurge: 'account/store.ts' }
  | { cascadeFrom: string }
  | { retainedAttribution: 'purge_bob_apps(uuid)' };

const ERASE = { definer: 'erase_account(uuid,timestamptz)' } as const;
const PURGE = { storePurge: 'store/account.ts' } as const;
const GAMES = { definer: 'purge_account_games(uuid)' } as const;
const SCOPES = { definer: 'purge_account_scopes(uuid)' } as const;

/** Every bob.* -> auth.users column, keyed `table.column`. Adding a table
 *  that names a user means adding its erasure path AND a line here. */
const HANDLED: Record<string, Handler> = {
  'bob_apps.user_id': { definer: 'purge_bob_apps(uuid)' },
  // Shared rows have no personal owner. Erasure retains them and explicitly clears
  // these exact attribution columns (auth.users itself is retained by erasure).
  // The full-workflow witness in shared-app-erasure.test.ts retains all seven.
  'bob_apps.created_by': { retainedAttribution: 'purge_bob_apps(uuid)' },
  'bob_app_installations.created_by': { retainedAttribution: 'purge_bob_apps(uuid)' },
  'bob_app_campaigns.created_by': { retainedAttribution: 'purge_bob_apps(uuid)' },
  'bob_app_campaign_sections.created_by': { retainedAttribution: 'purge_bob_apps(uuid)' },
  'bob_app_campaign_drafts.created_by': { retainedAttribution: 'purge_bob_apps(uuid)' },
  'marketing_config_proposals.created_by': { retainedAttribution: 'purge_bob_apps(uuid)' },
  'marketing_config_versions.created_by': { retainedAttribution: 'purge_bob_apps(uuid)' },
  'marketing_review_notes.author_user_id': { retainedAttribution: 'purge_bob_apps(uuid)' },
  'marketing_review_decisions.author_user_id': { retainedAttribution: 'purge_bob_apps(uuid)' },
  'marketing_review_operations.actor_user_id': { definer: 'purge_bob_apps(uuid)' },
  'bob_app_mutations.user_id': { definer: 'purge_bob_apps(uuid)' },
  'bob_app_refresh_settings.user_id': { cascadeFrom: 'bob_apps' },
  'bob_app_runs.user_id': { cascadeFrom: 'bob_apps' },
  // Personal installations/content cascade from the purged personal app. Shared
  // rows have user_id NULL; their identifying attribution is handled separately.
  'bob_app_installations.user_id': { cascadeFrom: 'bob_apps' },
  'bob_app_selection.user_id': { definer: 'purge_bob_apps(uuid)' },
  // Operation keys have no app foreign key, so purge_bob_apps deletes them by owner in the erasure transaction.
  'bob_app_marketing_operations.user_id': { definer: 'purge_bob_apps(uuid)' },
  // Campaign data and receipts follow the installation purge, including children of each campaign.
  'bob_app_campaigns.user_id': { cascadeFrom: 'bob_app_installations' },
  'bob_app_campaign_sections.user_id': { cascadeFrom: 'bob_app_campaigns' },
  'bob_app_campaign_drafts.user_id': { cascadeFrom: 'bob_app_campaigns' },
  'bob_app_campaign_selection.user_id': { definer: 'purge_bob_apps(uuid)' },
  'bob_app_campaign_operations.user_id': { definer: 'purge_bob_apps(uuid)' },
  // Configuration rows have composite installation cascades as well as explicit deletes in purge_bob_apps.
  'marketing_config_proposals.user_id': { cascadeFrom: 'bob_app_installations' },
  'marketing_config_versions.user_id': { cascadeFrom: 'bob_app_installations' },
  'marketing_config_operations.user_id': { definer: 'purge_bob_apps(uuid)' },
  'conversations.user_id': PURGE,
  'messages.user_id': { cascadeFrom: 'conversations' },
  'message_versions.user_id': { cascadeFrom: 'messages' },
  'memories.user_id': PURGE,
  'action_items.user_id': { cascadeFrom: 'memories' },
  'google_accounts.user_id': PURGE,
  // Erasure retains auth.users; purging the Google account triggers the
  // owner/account composite FK cascade for its routine definitions.
  'routines.user_id': { cascadeFrom: 'google_accounts' },
  'routine_runs.user_id': { cascadeFrom: 'routines' },
  // routine_results has composite account/run FKs, not a direct auth.users
  // FK; its cascade is exercised by the routines privacy erasure test.
  'tool_preferences.owner_user_id': { explicitStorePurge: 'account/store.ts' },
  'insights.user_id': { cascadeFrom: 'google_accounts' },
  'google_consent_attempts.user_id': PURGE,
  'google_native_consent_attempts.user_id': { definer: 'purge_account_google_native(uuid)' },
  'notification_preferences.user_id': PURGE,
  'approval_proposals.user_id': PURGE,
  'approval_audit.user_id': { cascadeFrom: 'approval_proposals' },
  'notifications.recipient_user_id': { definer: 'purge_account_notifications(uuid)' },
  'push_devices.user_id': { definer: 'purge_account_push(uuid)' },
  'push_receipts.user_id': { definer: 'purge_account_push(uuid)' },
  'game_sessions.user_id': GAMES,
  'game_usage.user_id': GAMES,
  // The auth.users cascade never fires (erasure keeps the auth row); the
  // definer runs in the erase_account transaction (store/erasure.ts).
  // The email marker lives on the outbox (20261003110000).
  'outbox.recipient_user_id': { definer: 'purge_account_email_effects(uuid)' },
  // bob.devices rows are revoked by DELETE /api/account after erasure (the
  // live socket is closed by device id); erase_account clears their settings.
  'devices.user_id': ERASE,
  'pairing_requests.approved_by': ERASE,
  'spaces.owner_user_id': ERASE,
  'spaces.group_chat_created_by': { definer: 'purge_account_group_chats(uuid)' },
  'group_chat_links.created_by': { definer: 'purge_account_group_chats(uuid)' },
  'space_memberships.user_id': ERASE,
  // #756 unified conversations (20261001100200_conversation_unify_erasure.sql);
  // the thread tables are gone (20261003100000_conversation_unify_contract.sql).
  'conversations.created_by': ERASE,
  'messages.author_user_id': ERASE,
  'conversation_reads.user_id': ERASE,
  'tasks.assignee_user_id': ERASE,
  'tasks.created_by': ERASE,
  'task_subscribers.user_id': ERASE,
  'calendars.created_by': ERASE,
  'calendar_events.organizer_user_id': ERASE,
  'event_attendees.user_id': ERASE,
  'ai_invocations.actor_user_id': ERASE,
  'space_invitations.accepted_by': ERASE,
  'space_invitations.created_by': ERASE,
  'notes.created_by': ERASE,
  'notes.updated_by': ERASE,
  'note_revisions.editor_user_id': ERASE,
  'reminders.created_by': ERASE,
  'reminder_recipients.user_id': ERASE,
  'reminder_occurrences.user_id': ERASE,
  'publications.actor_user_id': ERASE,
  'user_state.user_id': ERASE,
  // Permission scopes (20261004130000_user_scopes.sql): the auth.users cascade
  // never fires, so the definer runs in the erase_account transaction.
  'user_scopes.user_id': SCOPES,
};

/** SET NULL is defense in depth; supported erasure keeps auth.users and must clear attribution itself. */
async function clearsRetainedAttribution(db: Db, table: string, column: string, definer: string): Promise<boolean> {
  const [definition] = await db.query<{ body: string }>('select pg_get_functiondef($1::regprocedure) as body', [`bob_private.${definer}`]);
  const body = definition?.body.toLowerCase() ?? '';
  if (!hasRetainedCleanup(body, table, column)) return false;
  const [fk] = await db.query<{ count: number }>(`select count(*)::int as count from pg_constraint c
    join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey)
    where c.contype='f' and c.confrelid='auth.users'::regclass and c.confdeltype='n'
      and c.conrelid=$1::regclass and a.attname=$2`, [`bob.${table}`, column]);
  return fk?.count === 1;
}

function hasRetainedCleanup(body: string, table: string, column: string): boolean {
  if (column === 'author_user_id' && table === 'marketing_review_notes') {
    return /update\s+bob\.marketing_review_notes\s+set\s+author_user_id=null,source_message_id=null,source_conversation_id=null\s+where\s+author_user_id=owner_id/.test(body);
  }
  if (column === 'author_user_id' && table === 'marketing_review_decisions') {
    return /update\s+bob\.marketing_review_decisions\s+set\s+author_user_id=null,session_id=null\s+where\s+author_user_id=owner_id/.test(body);
  }
  if (column !== 'created_by') return false;
  const loop = /foreach\s+t\s+in\s+array\s+array\[([^\]]+)\]\s+loop\s+execute\s+format\('update bob\.%i set created_by=null where created_by=\$1',t\)\s+using\s+owner_id\s*;\s*end loop/.exec(body);
  return loop?.[1]?.split(',').map((value) => value.trim()).includes(`'${table}'`) ?? false;
}

describe.skipIf(!stackUp)('erasure covers every bob.* column that references auth.users', () => {
  type Support = typeof import('../support/test-db.ts');
  let support: Support;
  let pg: Awaited<ReturnType<Support['createTestDb']>>;
  let db: Db;
  let columns: string[];

  beforeAll(async () => {
    support = await import('../support/test-db.ts');
    pg = await support.createTestDb();
    db = support.asDb(pg);
    const rows = await db.query<{ ref: string }>(
      `SELECT DISTINCT cl.relname || '.' || a.attname AS ref
         FROM pg_constraint c
         JOIN pg_class cl ON cl.oid = c.conrelid
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f'
          AND c.confrelid = 'auth.users'::regclass
          AND c.connamespace = 'bob'::regnamespace
        ORDER BY 1`,
    );
    columns = rows.map((row) => row.ref);
  });

  afterAll(async () => {
    await support.closeTestDb(pg).catch(() => undefined);
  });

  it('the catalog finds the columns (the query itself works)', () => {
    expect(columns.length).toBeGreaterThan(0);
  });

  it('every catalog column has a declared erasure path', () => {
    const unhandled = columns.filter((ref) => HANDLED[ref] === undefined);
    expect(unhandled, 'add an erasure path and a HANDLED entry for these').toEqual([]);
  });

  it('every declared column still exists (the map never goes stale)', () => {
    expect(Object.keys(HANDLED).filter((ref) => !columns.includes(ref))).toEqual([]);
  });

  it('every declared path really touches its column', async () => {
    const accountSource = readFileSync(new URL('../../src/account/store.ts', import.meta.url), 'utf8');
    const failures: string[] = [];
    for (const [ref, handler] of Object.entries(HANDLED)) {
      const [table, column] = ref.split('.') as [string, string];
      if ('definer' in handler) {
        const rows = await db.query<{ body: string }>(
          `SELECT pg_get_functiondef($1::regprocedure) AS body`,
          [`bob_private.${handler.definer}`],
        );
        const body = rows[0]!.body.toLowerCase();
        if (!new RegExp(`bob\\.${table}\\s`).test(body) || !body.includes(column)) failures.push(`${ref}: not in ${handler.definer}`);
      } else if ('storePurge' in handler) {
        // deleteOwnRows deletes WHERE user_id = the account.
        if (column !== 'user_id' || !accountSource.includes(`'bob.${table}'`)) failures.push(`${ref}: not purged by store/account.ts`);
      } else if ('explicitStorePurge' in handler) {
        // Require the exact account predicate AND its parameter binding; a
        // table-name mention alone does not prove an owner-column purge.
        const deletion = new RegExp(`tx\\.query\\(\\s*['"]delete\\s+from\\s+bob\\.${table}\\s+where\\s+${column}\\s*=\\s*\\$1['"]\\s*,\\s*\\[userId\\]\\s*\\)`, 'i');
        if (!deletion.test(accountSource)) failures.push(`${ref}: no account-bound delete in ${handler.explicitStorePurge}`);
      } else if ('retainedAttribution' in handler) {
        if (!await clearsRetainedAttribution(db, table, column, handler.retainedAttribution)) failures.push(`${ref}: no exact retained-attribution cleanup and SET NULL FK`);
      } else {
        const rows = await db.query<{ total: number }>(
          `SELECT COUNT(*)::int AS total FROM pg_constraint
            WHERE contype = 'f' AND confdeltype = 'c'
              AND conrelid = $1::regclass AND confrelid = $2::regclass`,
          [`bob.${table}`, `bob.${handler.cascadeFrom}`],
        );
        const parentHandled = Object.keys(HANDLED).some((key) => key.startsWith(`${handler.cascadeFrom}.`));
        if (Number(rows[0]!.total) === 0 || !parentHandled) failures.push(`${ref}: no cascade from a handled ${handler.cascadeFrom}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
