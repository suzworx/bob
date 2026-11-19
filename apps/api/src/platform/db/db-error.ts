/** Why a database call failed, from driver codes only: never the message, SQL or connection details. */
export type DbFailureReason =
  | 'auth_failed'
  | 'host_not_found'
  | 'connection_refused'
  | 'connection_lost'
  | 'timeout'
  | 'permission_denied'
  | 'schema_missing'
  | 'unknown';

const BY_CODE: Readonly<Record<string, DbFailureReason>> = {
  '28P01': 'auth_failed',
  '28000': 'auth_failed',
  ENOTFOUND: 'host_not_found',
  EAI_AGAIN: 'host_not_found',
  ECONNREFUSED: 'connection_refused',
  ECONNRESET: 'connection_lost',
  EPIPE: 'connection_lost',
  ETIMEDOUT: 'timeout',
  '57014': 'timeout',
  '42501': 'permission_denied',
  '3F000': 'schema_missing',
  '42P01': 'schema_missing',
};

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Walks `cause` and AggregateError members (a dual-stack connect fails once per address), a few levels deep. */
export function classifyDbError(error: unknown, depth = 0): DbFailureReason {
  const reason = BY_CODE[codeOf(error) ?? ''];
  if (reason) return reason;
  if (depth >= 3 || typeof error !== 'object' || error === null) return 'unknown';
  const nested: unknown[] = error instanceof AggregateError ? [...(error.errors as unknown[])] : [];
  if ('cause' in error) nested.push(error.cause);
  for (const inner of nested) {
    const found = classifyDbError(inner, depth + 1);
    if (found !== 'unknown') return found;
  }
  return 'unknown';
}
