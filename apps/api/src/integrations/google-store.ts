import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StoreConflictError, StoreError, withUser, type Db } from '../platform/db/db.ts';

type AuthorizationCapabilities = Array<'calendar.read' | 'calendar.write' | 'gmail.read' | 'gmail.draft' | 'gmail.send' | 'gmail.modify'>;

interface GoogleAccount {
  id: string;
  installationId: string;
  connectSubject: string | null;
  /** Broker lookup selector, never actual-grant evidence. */
  authorizationCapabilities: AuthorizationCapabilities | null;
  accountId: string;
  email: string;
  name: string | null;
  customName: string | null;
  selected: boolean;
  createdAt: number;
}

type Row = {
  id: string;
  installation_id: string;
  connect_subject: string | null;
  authorization_capabilities: AuthorizationCapabilities | null;
  provider_account_id: string;
  email: string;
  name: string | null;
  custom_name: string | null;
  selected: boolean;
  created_at: Date | string;
};

function map(row: Row): GoogleAccount {
  return {
    id: row.id,
    installationId: row.installation_id,
    connectSubject: row.connect_subject,
    authorizationCapabilities: row.authorization_capabilities,
    accountId: row.provider_account_id,
    email: row.email,
    name: row.name,
    customName: row.custom_name ?? null,
    selected: row.selected,
    createdAt: new Date(row.created_at).getTime(),
  };
}

const ACCOUNT_COLUMNS = 'id, installation_id, connect_subject, authorization_capabilities, provider_account_id, email, name, custom_name, selected, created_at';

export async function listGoogleAccounts(db: Db, userId: string): Promise<GoogleAccount[]> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<Row>(`select ${ACCOUNT_COLUMNS} from bob.google_accounts order by created_at asc`);
    return rows.map(map);
  });
}

export async function addGoogleAccount(
  db: Db,
  userId: string,
  account: { installationId: string; accountId: string; email: string; name?: string | null; connectSubject?: string | null },
): Promise<GoogleAccount> {
  return withUser(db, userId, async (tx) => {
    try {
      // Serialize the first-account decision per user. Without this lock two
      // simultaneous consent callbacks can both observe an empty set and race
      // the partial unique index on selected=true.
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`google-accounts:${userId}`]);
      const exists = await tx.query<{ id: string }>('select id from bob.google_accounts limit 1');
      const rows = await tx.query<Row>(
        `insert into bob.google_accounts (user_id, installation_id, provider_account_id, email, name, selected, connect_subject)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (user_id, installation_id)
         do update set email = excluded.email,
                       name = excluded.name,
                       updated_at = now()
         where google_accounts.provider_account_id = excluded.provider_account_id
           and google_accounts.connect_subject is not distinct from excluded.connect_subject
         returning ${ACCOUNT_COLUMNS}`,
        [userId, account.installationId, account.accountId, account.email, account.name ?? null, exists.length === 0, account.connectSubject ?? null],
      );
      const row = rows[0];
      if (!row) throw new StoreConflictError('google_account_identity_mismatch');
      return map(row);
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError('google account insert failed');
    }
  });
}

const verifiedConnectionSchema = z.object({
  subject: z.string().regex(/^gc_[A-Za-z0-9_-]{43}$/),
  providerAccountId: z.string().min(1).max(512),
  email: z.email().max(320),
  name: z.string().max(256).nullable().optional(),
  reconnectAccountId: z.uuid().nullable(),
  completionHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** Called only after the exact subject's token identity has been verified.
 * Neither a repeated callback nor reconnect can replace an account identity. */
export async function persistVerifiedGoogleConnection(
  db: Db, userId: string, input: z.infer<typeof verifiedConnectionSchema>,
): Promise<GoogleAccount> {
  const connection = verifiedConnectionSchema.parse(input);
  return withUser(db, userId, async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`google-accounts:${userId}`]);
    const attempts = await tx.query<{ capabilities: AuthorizationCapabilities }>(
        `delete from bob.google_consent_attempts where state_hash = $1 and connect_subject = $2
         and reconnect_account_id is not distinct from $3::uuid and consumed_at is not null
         and expires_at > now() returning capabilities`,
        [connection.completionHash, connection.subject, connection.reconnectAccountId],
    );
    const attempt = attempts[0];
    if (!attempt) throw new StoreConflictError('google_consent_unavailable');
    return saveVerifiedGoogleConnection(tx, userId, connection, attempt.capabilities);
  });
}

/** Shared row persistence only. Callers hold the owner lock and have atomically
 * claimed their web/native consent and verified the exact provider identity. */
export async function saveVerifiedGoogleConnection(
  tx: Db, userId: string, input: Omit<z.infer<typeof verifiedConnectionSchema>, 'completionHash'>,
  capabilities: AuthorizationCapabilities,
): Promise<GoogleAccount> {
  const connection = verifiedConnectionSchema.omit({ completionHash: true }).strip().parse(input);
  if (connection.reconnectAccountId !== null) {
    const rows = await tx.query<Row>(
      `update bob.google_accounts set email = $1, name = $2, updated_at = now(), authorization_capabilities = $6
       where id = $3 and connect_subject = $4 and provider_account_id = $5 returning ${ACCOUNT_COLUMNS}`,
      [connection.email, connection.name ?? null, connection.reconnectAccountId, connection.subject, connection.providerAccountId, capabilities],
    );
    const row = rows[0];
    if (!row) throw new StoreConflictError('google_account_identity_mismatch');
    return map(row);
  }
  const exists = await tx.query<{ id: string }>('select id from bob.google_accounts limit 1');
  const rows = await tx.query<Row>(
    `insert into bob.google_accounts
     (user_id, installation_id, connect_subject, provider_account_id, email, name, selected, authorization_capabilities)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (user_id, connect_subject) do update set email = excluded.email,
       name = excluded.name, updated_at = now(), authorization_capabilities = excluded.authorization_capabilities
     where google_accounts.provider_account_id = excluded.provider_account_id
     returning ${ACCOUNT_COLUMNS}`,
    [userId, randomUUID(), connection.subject, connection.providerAccountId, connection.email, connection.name ?? null, exists.length === 0, capabilities],
  );
  const row = rows[0];
  if (!row) throw new StoreConflictError('google_account_identity_mismatch');
  return map(row);
}

export async function selectGoogleAccount(db: Db, userId: string, id: string): Promise<GoogleAccount | null> {
  return withUser(db, userId, async (tx) => {
    const exists = await tx.query<{ id: string }>('select id from bob.google_accounts where id = $1', [id]);
    if (exists.length === 0) return null;
    await tx.query('update bob.google_accounts set selected = false, updated_at = now()');
    const rows = await tx.query<Row>(
      `update bob.google_accounts set selected = true, updated_at = now() where id = $1 returning ${ACCOUNT_COLUMNS}`,
      [id],
    );
    return rows[0] ? map(rows[0]) : null;
  });
}

export async function deleteGoogleAccount(db: Db, userId: string, id: string): Promise<boolean> {
  return withUser(db, userId, async (tx) => {
    const deleted = await tx.query<{ selected: boolean }>('delete from bob.google_accounts where id = $1 returning selected', [id]);
    if (deleted.length !== 1) return false;
    const row = deleted[0];
    if (!row) throw new StoreError('deleteGoogleAccount: no row');
    if (row.selected) {
      await tx.query(
        `update bob.google_accounts
            set selected = true, updated_at = now()
          where id = (select id from bob.google_accounts order by created_at asc limit 1)`,
      );
    }
    return true;
  });
}

export async function getGoogleAccount(db: Db, userId: string, id: string): Promise<GoogleAccount | null> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<Row>(`select ${ACCOUNT_COLUMNS} from bob.google_accounts where id = $1`, [id]);
    return rows[0] ? map(rows[0]) : null;
  });
}

export async function getSelectedGoogleAccount(db: Db, userId: string): Promise<GoogleAccount | null> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<Row>(
      `select ${ACCOUNT_COLUMNS} from bob.google_accounts where selected = true order by created_at asc limit 1`,
    );
    return rows[0] ? map(rows[0]) : null;
  });
}

/** Renames only an account visible under the owner's row-level policy. */
export async function renameGoogleAccount(db: Db, userId: string, id: string, customName: string | null): Promise<GoogleAccount | null> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<Row>(
      `update bob.google_accounts set custom_name = $2, updated_at = now() where id = $1 returning ${ACCOUNT_COLUMNS}`,
      [id, customName],
    );
    return rows[0] ? map(rows[0]) : null;
  });
}
