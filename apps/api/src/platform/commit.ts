/**
 * The deployed commit, shared by GET /api/version and the browser monitoring
 * config. Platform level so feature modules can read it without importing a
 * web-*.ts transport file.
 */
import { z } from 'zod';

const CommitSha = z.string().trim().toLowerCase().regex(/^[0-9a-f]{7,40}$/);

/** The deployed commit, or null when the host did not say (or said nonsense). */
export function resolveCommit(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of ['RAILWAY_GIT_COMMIT_SHA', 'BOB_COMMIT_SHA']) {
    const parsed = CommitSha.safeParse(env[name]);
    if (parsed.success) return parsed.data;
  }
  return null;
}
