// Metadata only: `fields` never carries transcripts, audio, prompts or credentials.
import type { TurnLifecycleEvent } from './turn-core.ts';
import { canonicalId } from '../platform/ids.ts';
import { moduleJournal } from '../platform/logger.ts';
import type { JournalFields } from '../platform/logger.ts';

const journal = moduleJournal('voice');

/** The turn's own conversation id in its canonical spelling; the journal then names the source the turn really uses. */
function canonicalFields(fields: JournalFields): JournalFields {
  const raw = fields.conversation_id;
  // Only uuid-backed spellings: canonicalId would hash anything else into a new id.
  const canonical = typeof raw === 'string' && /^(?:cnv|thr|conv)_[0-9a-f-]{32,36}$/i.test(raw) ? canonicalId('conversation', raw) : null;
  return canonical === null ? fields : { ...fields, conversation_id: canonical };
}

export function journalTurnStage(event: TurnLifecycleEvent): void {
  journal(`v2.turn_stage_${event.stage}_${event.outcome}`, {
    interface: event.interface,
    turn_id: event.turnId,
    stage: event.stage,
    outcome: event.outcome,
    ...canonicalFields(event.fields as JournalFields),
  });
}