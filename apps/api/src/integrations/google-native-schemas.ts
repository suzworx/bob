import { z } from 'zod';
import { GoogleAuthorizeRequestSchema, GoogleAccountResponseSchema } from './google-schemas.ts';

export const GoogleNativeAuthorizeSchema = GoogleAuthorizeRequestSchema.extend({
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
export const GoogleNativeProofSchema = z.object({
  attemptId: z.uuid(), state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
}).strict();
export type GoogleNativeProof = z.infer<typeof GoogleNativeProofSchema>;
export const GoogleNativeAuthorizationSchema = z.object({
  attemptId: z.uuid(), state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  url: z.url().refine((value) => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }),
  expiresAt: z.number().int().positive(),
}).strict();
export const GoogleNativeResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), account: GoogleAccountResponseSchema.shape.account }).strict(),
  z.object({ status: z.literal('processing'), retryAfterMs: z.number().int().min(250).max(5000) }).strict(),
  z.object({ status: z.enum(['failed', 'cancelled', 'expired']) }).strict(),
]);
export const GoogleNativeReturnSchema = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), error: z.string().min(1).max(64).optional(),
}).strict();
