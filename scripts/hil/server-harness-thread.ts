import { canonicalId } from '../../apps/api/src/platform/ids.ts';

/** Verify identity and storage scope, never infer either from an ID prefix. */
export async function verifyThreadEvidence(
  action: 'verify-selected' | 'verify-general',
  text: string,
  seededId: string | null,
  isPrivateConversation: (id: string) => Promise<boolean>,
): Promise<string> {
  if (!seededId) return 'failed_not_seeded';
  const event = action === 'verify-selected' ? 'v2.conversation_selected' : 'v2.turn_completed';
  let actual: unknown;
  for (const line of text.split('\n')) {
    let record: Record<string, unknown> | null;
    try { record = JSON.parse(line) as typeof record; } catch { continue; }
    if (record?.event === event) actual = record.conversation_id;
  }
  if (typeof actual !== 'string' || !actual) return 'failed_no_evidence';
  const matchesSeed = canonicalId('conversation', actual) === canonicalId('conversation', seededId);
  if (action === 'verify-selected') return matchesSeed ? 'selected_seed' : 'failed_wrong_thread';
  if (matchesSeed || !(await isPrivateConversation(actual))) return 'failed_not_general';
  return 'general_verified';
}
