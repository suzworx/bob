/**
 * Account-related schemas: authentication config, test tokens, and account deletion.
 */
import { z } from 'zod';

// --- Supabase auth DTOs (T010, contracts/web-auth.md) -----------------------

/** Unauthenticated GET /api/public-config payload: publishable key only,
 *  never a secret or service-role value (R6). */
const PublicConfigSchema = z
  .object({
    supabaseUrl: z.string().url(),
    supabasePublishableKey: z.string().min(1),
    pairingUrl: z.string().url(),
    /** True only when /api/test-token is mounted: loopback bind, system-test
     *  issuer active, never under BOB_PRODUCTION=1. The UI shows a local-only
     *  dev sign-in button from it. */
    devSignIn: z.boolean(),
  })
  .strict();

/** POST /api/test-token request (system-test issuer, loopback bind only). */
export const TestTokenRequestSchema = z.object({ userId: z.string().uuid() }).strict();

/** POST /api/test-token response: a JWT the regular guard verifies. */
const TestTokenResponseSchema = z
  .object({ token: z.string().min(1), expiresAt: z.number().int().positive() })
  .strict();

type PublicConfig = z.infer<typeof PublicConfigSchema>;
type TestTokenRequest = z.infer<typeof TestTokenRequestSchema>;
type TestTokenResponse = z.infer<typeof TestTokenResponseSchema>;

// --- Account deletion DTOs (G6, issue #143; web-account.ts) ------------------
/** DELETE /api/account body: an explicit confirmation so no stray call can erase. */
export const AccountDeleteRequestSchema = z.object({ confirm: z.literal(true) }).strict();
type AccountDeleteRequest = z.infer<typeof AccountDeleteRequestSchema>;
/** DELETE /api/account 409 body: how many groups the caller still solely owns. Count only. */
export const AccountDeleteRefusedSchema = z
  .object({ error: z.object({ code: z.literal('owns_groups'), count: z.number().int().positive() }).strict() })
  .strict();
