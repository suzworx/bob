/** Typed process configuration, read once from the environment by the code that needs it. */

export interface FirmwareGithubConfig {
  /** owner/name of the repository whose releases carry the signed firmware bundle. */
  repo: string;
  /** Optional token; it only lifts GitHub's anonymous rate limit and is never logged. */
  token: string | undefined;
  timeoutMs: number;
  maxBytes: number;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function firmwareGithubConfig(env: NodeJS.ProcessEnv = process.env): FirmwareGithubConfig {
  const repo = env.BOB_FW_GITHUB_REPO?.trim() || 'suzworx/Bob';
  if (!REPO_RE.test(repo)) throw new Error('BOB_FW_GITHUB_REPO must look like owner/name');
  return { repo, token: env.BOB_FW_GITHUB_TOKEN?.trim() || undefined, timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 };
}
