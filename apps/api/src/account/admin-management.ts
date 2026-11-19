import { z } from 'zod';
import { asServer, type Db } from '../platform/db/db.ts';
import {
  AdminSearchResponseSchema,
  type AdminSearchRequestSchema,
  type AdminMutationRequestSchema,
} from './admin-schemas.ts';

export async function searchAdminAccounts(
  db: Db,
  userId: string,
  sessionId: string,
  input: z.output<typeof AdminSearchRequestSchema>,
): Promise<z.output<typeof AdminSearchResponseSchema>> {
  const rows = await asServer(db, (server) =>
    server.query<{ result: unknown }>(
      'select bob_private.admin_accounts_search($1::uuid,$2::uuid,$3::text,$4::int,$5::text) as result',
      [
        userId,
        sessionId,
        input.query,
        input.limit,
        input.cursor ? JSON.stringify(input.cursor) : null,
      ],
    ),
  );
  const result = AdminSearchResponseSchema.parse(rows[0]?.result);
  return {
    ...result,
    nextCursor: result.nextCursor ? Buffer.from(result.nextCursor).toString('base64url') : null,
  };
}
const MutationOutcomeSchema = z.enum([
  'updated',
  'forbidden',
  'invalid_action',
  'not_found',
  'self_protected',
  'last_admin',
]);

export async function mutateAdminAccount(
  db: Db,
  userId: string,
  sessionId: string,
  input: z.output<typeof AdminMutationRequestSchema>,
): Promise<string> {
  const rows = await asServer(db, (server) =>
    server.query<{ result: string }>(
      'select bob_private.admin_account_mutate($1::uuid,$2::uuid,$3::uuid,$4::text) as result',
      [userId, sessionId, input.accountId, input.action],
    ),
  );
  return MutationOutcomeSchema.parse(rows[0]?.result);
}
