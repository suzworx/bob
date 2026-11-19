import { pttTurn } from './steps.mjs';

// After a turn the reply card stays on READY: the device got the turn's
// reply_text (lengths only in the journal, never the text), kept it for this
// turn, and showed it once playback ended. Backtick only closes the card.
export default {
  name: 'reply-card',
  issue: '#318',
  title: 'reply card shown after a turn, backtick closes it',
  requires: [
    { event: 'reply_text_received', feature: 'reply_text on the device (#318)' },
    { event: 'reply_card_shown', feature: 'reply card after playback (#318)' },
  ],
  steps: [
    { assertState: { state: 'READY' } },
    ...pttTurn(),
    // Both waits look back to the turn's last press (GO released).
    { waitDevice: /INFO v2\.reply_text_received state=WAIT .*kept=1/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.reply_card_shown state=READY .*lines=[1-9]/, timeoutMs: 5000 },
    { press: 'backtick' },
    { waitDevice: /INFO v2\.reply_card_closed state=READY/, timeoutMs: 3000 },
    { assertState: { state: 'READY' } },
  ],
};
