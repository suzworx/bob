// k from push-to-talk enters "Always awake". Two outcomes both pass: the wake
// word model starts listening (`wake_listening`), or it could not start and
// the device falls back to push-to-talk with a notice (`wake_unavailable`,
// reason=begin|mic). The report's evidence shows which one this device took,
// and the mode_changed line carries wake_fallback=0|1 to match. The scenario
// ends back in push-to-talk.
export default {
  name: 'wake-mode',
  issue: '#313',
  title: 'k enters Always awake: wake_listening, or the fallback notice (evidence says which)',
  requires: [
    { event: 'wake_listening', feature: 'Always awake mode (#313)' },
    { event: 'wake_unavailable', feature: 'Always awake fallback (#313)' },
  ],
  steps: [
    { assertState: { state: 'READY', mode: 'ptt' } },
    { press: 'k' },
    { waitDevice: /INFO v2\.mode_changed .*mode=wake,wake_fallback=[01],source=key/, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.(wake_listening|wake_unavailable) /, timeoutMs: 5000 },
    { assertState: { state: 'READY', mode: 'wake' } },
    // Leave the mode through the server so the mic is released the same way
    // whichever outcome happened.
    { send: 'T server control mode=ptt', expect: /^ok server$/ },
    { waitDevice: /INFO v2\.mode_changed .*mode=ptt,.*source=server/, timeoutMs: 5000 },
    { assertState: { state: 'READY', mode: 'ptt' } },
  ],
};
