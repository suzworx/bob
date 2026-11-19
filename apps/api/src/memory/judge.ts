/** The memory judge both turn paths share. Its own module so tests that mock
 *  callbacks.ts keep working. */
import { createMemoryJudge, type MemoryJudge } from '@bob/ai';

let sharedJudge: MemoryJudge | null = null;

export function defaultMemoryJudge(): MemoryJudge {
  sharedJudge ??= createMemoryJudge();
  return sharedJudge;
}
