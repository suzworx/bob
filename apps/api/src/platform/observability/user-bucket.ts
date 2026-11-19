import { createHash } from 'node:crypto';

/** A one-way account bucket 0..1023 for approximate distinct counts; null when there is no account. */
export function userBucket(accountId: string | undefined): number | null {
  if (!accountId) return null;
  return createHash('sha256').update(accountId).digest().readUInt32BE(0) % 1024;
}
