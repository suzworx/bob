/**
 * Vitest suite for the shared turn-stage journal helper in turn-journal.ts:
 * event-name derivation, snake_case metadata presence, and field spreading.
 * The logger is mocked so assertions target journalTurnStage's contract only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { journal } from '../../src/platform/logger.ts';
import { journalTurnStage } from '../../src/voice/turn-journal.ts';
import type { TurnLifecycleEvent } from '../../src/voice/turn-core.ts';

vi.mock('../../src/platform/logger.ts', async () => (await import('../helpers/journal-mock.ts')).loggerMock());

function lifeEvent(overrides: Partial<TurnLifecycleEvent> = {}): TurnLifecycleEvent {
  return {
    interface: 'cardputer',
    turnId: 'turn_abc123',
    stage: 'stt',
    outcome: 'started',
    fields: {},
    ...overrides,
  };
}

describe('journalTurnStage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives the event name as v2.turn_stage_<stage>_<outcome>', () => {
    journalTurnStage(lifeEvent({ stage: 'stt', outcome: 'started' }));
    journalTurnStage(lifeEvent({ interface: 'web', stage: 'agent', outcome: 'failed' }));
    journalTurnStage(lifeEvent({ stage: 'input', outcome: 'completed' }));
    expect(journal).toHaveBeenNthCalledWith(1, 'v2.turn_stage_stt_started', expect.any(Object));
    expect(journal).toHaveBeenNthCalledWith(2, 'v2.turn_stage_agent_failed', expect.any(Object));
    expect(journal).toHaveBeenNthCalledWith(3, 'v2.turn_stage_input_completed', expect.any(Object));
  });

  it('includes interface, turn_id, stage, and outcome in snake_case', () => {
    journalTurnStage(lifeEvent({ turnId: 'turn_xyz', stage: 'agent', outcome: 'failed' }));
    expect(vi.mocked(journal).mock.calls[0]?.[1]).toMatchObject({
      interface: 'cardputer',
      turn_id: 'turn_xyz',
      stage: 'agent',
      outcome: 'failed',
    });
  });

  it('spreads fields through as given', () => {
    journalTurnStage(
      lifeEvent({ fields: { kind: 'internal', error_name: 'TimeoutError', retries: 2 } }),
    );
    expect(vi.mocked(journal).mock.calls[0]?.[1]).toMatchObject({
      kind: 'internal',
      error_name: 'TimeoutError',
      retries: 2,
    });
  });
});