import { StoreConflictError, StoreNotFoundError } from '../platform/db/db.ts';

export class GroupChatFullError extends StoreConflictError {
  constructor() { super('This group chat is full.'); this.name = 'GroupChatFullError'; }
}

/** SQL lifecycle functions deliberately distinguish unavailable invitations
 * from capacity. Infrastructure failures retain their original error. */
export function groupLifecycleError(error: unknown): never {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === 'P0002') throw new StoreNotFoundError('group chat not found');
    if (error.code === '23514') throw new GroupChatFullError();
  }
  throw error;
}
