// n opens the confirmation, Enter sends new_conversation, the server clears
// the active conversation and the device returns to READY.
export default {
  name: 'new-conversation',
  issue: '#302',
  title: 'n → Enter → conversation_cleared ack',
  requires: [{ event: 'new_conversation_acked', feature: 'new conversation from the keyboard (#302)' }],
  steps: [
    { assertState: { state: 'READY' } },
    { press: 'n' },
    { waitDevice: /INFO v2\.new_conversation_opened/, timeoutMs: 3000 },
    { press: 'enter' },
    { waitDevice: /INFO v2\.new_conversation_sent/, timeoutMs: 3000 },
    { waitServer: /"event":"v2\.new_conversation"/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.new_conversation_acked/, timeoutMs: 6000 },
    { assertState: { state: 'READY' } },
    // The cancel path: n then backtick sends nothing and returns to READY.
    { press: 'n' },
    { waitDevice: /INFO v2\.new_conversation_opened/, timeoutMs: 3000 },
    { press: 'backtick' },
    { waitDevice: /INFO v2\.new_conversation_cancelled/, timeoutMs: 3000 },
    { assertState: { state: 'READY' } },
  ],
};
