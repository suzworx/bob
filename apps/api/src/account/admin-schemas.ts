import { z } from 'zod';

export const AdminAccountRequestSchema = z
  .object({
    retryInvitation: z.boolean().optional(),
    email: z
      .string()
      .trim()
      .max(254)
      .email()
      .transform((value) => value.toLowerCase()),
  })
  .strict();

export const AdminAccountResponseSchema = z
  .object({
    status: z.enum(['created', 'exists']),
    invitation: z.enum(['queued', 'sent', 'failed']),
  })
  .strict();

const AdminCursorSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  })
  .strict();
export const AdminSearchRequestSchema = z
  .object({
    query: z.string().trim().max(254).default(''),
    limit: z.number().int().min(1).max(50).default(25),
    cursor: z
      .string()
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/)
      .transform((value, context) => {
        try {
          return AdminCursorSchema.parse(
            JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
          );
        } catch {
          context.addIssue({ code: 'custom', message: 'Invalid cursor' });
          return z.NEVER;
        }
      })
      .optional(),
  })
  .strict();
const AdminManagedAccountSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().nullable(),
    createdAt: z.string(),
    lastSignInAt: z.string().nullable(),
    status: z.enum(['enabled', 'disabled']),
    isAdmin: z.boolean(),
    emailConfirmed: z.boolean(),
  })
  .strict();
export const AdminSearchResponseSchema = z
  .object({
    accounts: z.array(AdminManagedAccountSchema),
    counts: z
      .object({
        total: z.number().int().nonnegative(),
        enabled: z.number().int().nonnegative(),
        disabled: z.number().int().nonnegative(),
        awaitingConfirmation: z.number().int().nonnegative(),
      })
      .strict(),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const AdminMutationRequestSchema = z
  .object({
    accountId: z.string().uuid(),
    action: z.enum(['enable', 'disable', 'grant_admin', 'revoke_admin']),
  })
  .strict();
export const AdminMutationResponseSchema = z.object({ status: z.literal('updated') }).strict();
