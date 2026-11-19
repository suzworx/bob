// k cycles the listening mode ptt → wake → announce_only → ptt. Three presses
// must come back to where they started, and every press must change the mode.
export default {
  name: 'mode-cycle',
  issue: '#330',
  title: 'mode key k cycles through all three modes and back',
  requires: [{ event: 'mode_changed', feature: 'mode cycle on k (#330)' }],
  steps: [
    { assertState: { state: 'READY' } },
    { saveState: 'start' },
    { press: 'k' },
    { waitDevice: /INFO v2\.mode_changed/, timeoutMs: 3000 },
    { assertState: { mode: { differs: 'start' } } },
    { saveState: 'second' },
    { press: 'k' },
    { waitDevice: /INFO v2\.mode_changed/, timeoutMs: 3000 },
    { assertState: { mode: { differs: 'second' } } },
    { saveState: 'third' },
    { assertState: { mode: { differs: 'start' } } },
    { press: 'k' },
    { waitDevice: /INFO v2\.mode_changed/, timeoutMs: 3000 },
    { assertState: { state: 'READY', mode: { same: 'start' } } },
  ],
};
