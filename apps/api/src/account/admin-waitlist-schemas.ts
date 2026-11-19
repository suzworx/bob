import { z } from 'zod';
import { AdminSearchRequestSchema } from './admin-schemas.ts';

export const AdminWaitlistRequestSchema = AdminSearchRequestSchema.extend({
  status: z.enum(['all', 'verified', 'pending', 'waiting', 'with_account']).default('all'),
}).strict();
const count = z.number().int().nonnegative();
export const AdminWaitlistResponseSchema = z.object({
  entries: z.array(z.object({
    id: z.string().uuid(),
    email: z.string().max(254),
    source: z.string().min(1).max(40),
    createdAt: z.string().datetime({ offset: true }),
    verifiedAt: z.string().datetime({ offset: true }).nullable(),
    accountStatus: z.enum(['none', 'enabled', 'disabled']),
  }).strict()),
  counts: z.object({ total: count, verified: count, pending: count, withAccount: count, waitingVerified: count }).strict(),
  nextCursor: z.string().nullable(),
}).strict();
