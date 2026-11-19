import { z } from 'zod';
import { fetchWithAuth } from '@/lib/auth/use-session';

const ResponseSchema = z
  .object({
    status: z.enum(['created', 'exists']),
    invitation: z.enum(['queued', 'sent', 'failed']),
  })
  .strict();

export type AdminResult = z.infer<typeof ResponseSchema>;

/** What an add or invite did, in plain words for a toast; null when the invite needs retrying. */
export function inviteOutcome(result: AdminResult, email: string): string | null {
  if (result.invitation === 'failed') return null;
  if (result.status === 'exists') return `${email} already has an account`;
  return `Invite sent to ${email}`;
}
export class AdminRequestError extends Error {
  constructor(readonly status: number) {
    super('Account administration request failed');
  }
}
export async function probeAdminAccess(): Promise<boolean> {
  const response = await fetchWithAuth('/api/admin/access');
  if (response.status === 204) return true;
  if (response.status === 401 || response.status === 404) return false;
  throw new AdminRequestError(response.status);
}
export async function addPerson(email: string, retryInvitation = false): Promise<AdminResult> {
  const response = await fetchWithAuth('/api/admin/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      ...(retryInvitation ? { retryInvitation: true } : {}),
    }),
  });
  if (!response.ok) throw new AdminRequestError(response.status);
  const parsed = ResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new AdminRequestError(502);
  return parsed.data;
}

const ManagedAccountSchema = z
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
const SearchResultSchema = z
  .object({
    accounts: z.array(ManagedAccountSchema),
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
export type ManagedAccount = z.infer<typeof ManagedAccountSchema>;
export type AccountSearchResult = z.infer<typeof SearchResultSchema>;
export type AccountAction = 'enable' | 'disable' | 'grant_admin' | 'revoke_admin';
export async function searchAccounts(query: string, cursor?: string): Promise<AccountSearchResult> {
  const response = await fetchWithAuth('/api/admin/accounts/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, limit: 25, ...(cursor ? { cursor } : {}) }),
  });
  if (!response.ok) throw new AdminRequestError(response.status);
  const parsed = SearchResultSchema.safeParse(await response.json());
  if (!parsed.success) throw new AdminRequestError(502);
  return parsed.data;
}
export async function manageAccount(accountId: string, action: AccountAction): Promise<void> {
  const response = await fetchWithAuth('/api/admin/accounts/manage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, action }),
  });
  if (!response.ok) throw new AdminRequestError(response.status);
  if (
    !z
      .object({ status: z.literal('updated') })
      .strict()
      .safeParse(await response.json()).success
  )
    throw new AdminRequestError(502);
}

const WaitlistEntrySchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  source: z.string(),
  createdAt: z.string(),
  verifiedAt: z.string().nullable(),
  accountStatus: z.enum(['none', 'enabled', 'disabled']),
}).strict();
const WaitlistResultSchema = z.object({
  entries: z.array(WaitlistEntrySchema),
  counts: z.object({
    total: z.number().int().nonnegative(),
    verified: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    withAccount: z.number().int().nonnegative(),
    waitingVerified: z.number().int().nonnegative(),
  }).strict(),
  nextCursor: z.string().nullable(),
}).strict();
export type WaitlistEntry = z.infer<typeof WaitlistEntrySchema>;
export type WaitlistResult = z.infer<typeof WaitlistResultSchema>;
export type WaitlistStatus = 'all' | 'verified' | 'pending' | 'waiting' | 'with_account';

export async function searchWaitlist(query: string, status: WaitlistStatus, cursor?: string): Promise<WaitlistResult> {
  const response = await fetchWithAuth('/api/admin/waitlist/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, status, limit: 25, ...(cursor ? { cursor } : {}) }),
  });
  if (!response.ok) throw new AdminRequestError(response.status);
  const parsed = WaitlistResultSchema.safeParse(await response.json());
  if (!parsed.success) throw new AdminRequestError(502);
  return parsed.data;
}
