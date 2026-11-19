import type { z } from 'zod';
import { asServer, type Db } from '../platform/db/db.ts';
import { AdminWaitlistResponseSchema, type AdminWaitlistRequestSchema } from './admin-waitlist-schemas.ts';

export async function searchAdminWaitlist(
  db: Db,
  userId: string,
  sessionId: string,
  input: z.output<typeof AdminWaitlistRequestSchema>,
): Promise<z.output<typeof AdminWaitlistResponseSchema>> {
  const rows = await asServer(db, (server) => server.query<{ result: unknown }>(
    'select bob_private.admin_waitlist_search($1::uuid,$2::uuid,$3::text,$4::int,$5::text,$6::text) as result',
    [userId, sessionId, input.query, input.limit, input.cursor ? JSON.stringify(input.cursor) : null, input.status],
  ));
  const result = AdminWaitlistResponseSchema.parse(rows[0]?.result);
  return { ...result, nextCursor: result.nextCursor ? Buffer.from(result.nextCursor).toString('base64url') : null };
}
