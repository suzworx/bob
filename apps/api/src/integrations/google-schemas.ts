/**
 * Google account integration schemas.
 */
import { z } from 'zod';

export const GoogleAccountCreateSchema = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
export const GoogleAuthorizeRequestSchema = z.object({
  capabilities: z.array(z.enum(['calendar.read', 'calendar.write', 'gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify'])).min(1).max(6),
  reconnectAccountId: z.string().uuid().optional(),
}).strict();
export const GoogleAccountUpdateSchema = z.object({
  customName: z.string().trim().min(1).max(60).nullable(),
}).strict();
export const GoogleAccountIdSchema = z.string().uuid();
export const GoogleAuthorizeResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.number().int().positive(),
}).strict();
const GoogleAccountSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().nullable(),
  customName: z.string().min(1).max(60).nullable().default(null),
  selected: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  /** The access last requested for this account, so Change access can start
   * from it. A request is not a grant: operations still verify live scopes. */
  access: z.array(z.enum(['calendar.read', 'calendar.write', 'gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify'])).max(6),
  /** The account cannot be used until it is connected again. */
  needsReconnect: z.boolean(),
}).strict();
export const GoogleAccountsResponseSchema = z.object({ accounts: z.array(GoogleAccountSchema) }).strict();
export const GoogleAccountResponseSchema = z.object({ account: GoogleAccountSchema }).strict();
export const GoogleSmokeQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(10).default(3),
}).strict();
export const GoogleSmokeResponseSchema = z.object({
  account: GoogleAccountSchema,
  mailbox: z.object({ email: z.string().email() }).strict(),
  messages: z.array(z.object({ id: z.string().min(1), subject: z.string().nullable() }).strict()),
}).strict();
type GoogleAccountCreate = z.infer<typeof GoogleAccountCreateSchema>;
type GoogleAuthorizeRequest = z.infer<typeof GoogleAuthorizeRequestSchema>;
type GoogleSmokeQuery = z.infer<typeof GoogleSmokeQuerySchema>;
