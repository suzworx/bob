// s opens the Space picker (list_spaces), Enter confirms the highlighted row
// and the server acks select_space; s then backtick cancels.
export default {
  name: 'space-picker',
  issue: '#301',
  title: 'Space picker: s → list → Enter selects; s → backtick cancels',
  requires: [{ event: 'space_picker_opened', feature: 'Space picker on s (#301)' }],
  steps: [
    { assertState: { state: 'READY' } },
    { press: 's' },
    { waitDevice: /INFO v2\.space_picker_opened/, timeoutMs: 3000 },
    { waitServer: /"event":"v2\.space_listed"/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.spaces_received/, timeoutMs: 5000 },
    { press: 'enter' },
    { waitDevice: /INFO v2\.space_select_sent/, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.space_selected/, timeoutMs: 6000 },
    { assertState: { state: 'READY' } },
    { press: 's' },
    { waitDevice: /INFO v2\.spaces_received/, timeoutMs: 5000 },
    { press: 'backtick' },
    { waitDevice: /INFO v2\.picker_cancelled/, timeoutMs: 3000 },
    { assertState: { state: 'READY' } },
  ],
};
