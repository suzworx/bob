// - and = step the volume, m toggles mute; every change is read back with
// `T state` rather than trusted from the key press. Relative checks clamp at
// 0 and 10, so the scenario holds wherever the saved volume sits.
export default {
  name: 'volume-mute',
  issue: '#314',
  title: 'volume - / = and mute m, with state readback',
  requires: [
    { event: 'volume_changed', feature: 'volume keys - and = (#314)' },
    { event: 'mute_changed', feature: 'mute key m (#314)' },
  ],
  steps: [
    { assertState: { state: 'READY' } },
    { saveState: 'before' },
    // No journal wait on the volume keys: at 10 (or 0) a press changes
    // nothing and the firmware may rightly journal nothing. The readback is
    // the evidence.
    // A level change always unmutes (firmware onVolumeKey).
    { press: '=' },
    { assertState: { vol: { delta: 1, of: 'before' }, muted: 0 } },
    { saveState: 'raised' },
    { press: '-' },
    { assertState: { vol: { delta: -1, of: 'raised' } } },
    { saveState: 'unmuted' },
    { press: 'm' },
    { waitDevice: /INFO v2\.mute_changed/, timeoutMs: 3000 },
    { assertState: { muted: { differs: 'unmuted' }, vol: { same: 'unmuted' } } },
    { press: 'm' },
    { waitDevice: /INFO v2\.mute_changed/, timeoutMs: 3000 },
    { assertState: { state: 'READY', muted: { same: 'unmuted' }, vol: { same: 'unmuted' } } },
  ],
};
