import { backToPtt, wakeTurnToFollowUp } from './steps.mjs';

// Any key closes the follow-up window at once and does nothing else: `h`
// pressed while the window is open closes it (reason=key) without opening
// HELP, and wake listening resumes.
export default {
  name: 'wake-followup-key',
  issue: '#313',
  title: 'follow-up window: a key closes it at once (reason=key), wake listening resumes',
  requires: [{ event: 'followup_closed', feature: 'follow-up listening (CP-WAKE-FOLLOWUP)' }],
  steps: [
    { assertState: { state: 'READY', mode: 'ptt' } },
    ...wakeTurnToFollowUp(),
    { press: 'h' },
    { waitDevice: /INFO v2\.followup_closed state=READY .*reason=key/, timeoutMs: 2000 },
    { noDevice: /INFO v2\.help_opened /, timeoutMs: 1000 },
    { waitDevice: /INFO v2\.wake_listening /, timeoutMs: 5000 },
    { assertState: { state: 'READY', mode: 'wake' } },
    ...backToPtt(),
  ],
};
