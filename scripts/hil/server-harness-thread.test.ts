import { describe, expect, it, vi } from 'vitest';
import { verifyThreadEvidence } from './server-harness-thread.ts';

const seed = 'conv_11111111111111111111111111111111';
const other = 'conv_22222222222222222222222222222222';
const line = (event: string, id: string): string => JSON.stringify({ event, conversation_id: id });

describe('thread-pointer identity evidence', () => {
  it('accepts only the actual seeded thread selection, independent of prefix', async () => {
    const lookup = vi.fn(async () => true);
    expect(await verifyThreadEvidence('verify-selected', line('v2.conversation_selected', seed), seed, lookup)).toBe('selected_seed');
    expect(await verifyThreadEvidence('verify-selected', line('v2.conversation_selected', other), seed, lookup)).toBe('failed_wrong_thread');
    expect(lookup).not.toHaveBeenCalled();
  });
  it('matches canonical journal IDs to the exact legacy database thread ID', async () => {
    const lookup = vi.fn(async () => false);
    const legacy = '11111111-1111-1111-1111-111111111111';
    expect(await verifyThreadEvidence('verify-selected', line('v2.conversation_selected', seed), legacy, lookup)).toBe('selected_seed');
    expect(await verifyThreadEvidence('verify-general', line('v2.turn_completed', seed), legacy, lookup)).toBe('failed_not_general');
  });
  it('requires a completed conversation distinct from the seed and verified private by the store', async () => {
    const lookup = vi.fn(async (id: string) => id === other);
    expect(await verifyThreadEvidence('verify-general', line('v2.turn_completed', seed), seed, lookup)).toBe('failed_not_general');
    expect(await verifyThreadEvidence('verify-general', line('v2.turn_completed', other), seed, lookup)).toBe('general_verified');
    expect(await verifyThreadEvidence('verify-general', line('v2.turn_completed', 'conv_shared'), seed, lookup)).toBe('failed_not_general');
  });
  it('rejects absent evidence and uses the latest matching event rather than an earlier success', async () => {
    const lookup = vi.fn(async () => true);
    expect(await verifyThreadEvidence('verify-selected', 'invalid\n{}\nnull', seed, lookup)).toBe('failed_no_evidence');
    expect(await verifyThreadEvidence('verify-selected', line('v2.conversation_selected', seed), null, lookup)).toBe('failed_not_seeded');
    const history = [line('v2.conversation_selected', seed), line('v2.conversation_selected', other)].join('\n');
    expect(await verifyThreadEvidence('verify-selected', history, seed, lookup)).toBe('failed_wrong_thread');
  });
});
