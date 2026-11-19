// Epic #343 (OTA-6): power is cut while the new image downloads. The bridge
// resets the device mid-download; the slot it was writing is not bootable
// (the boot partition switches only after the hash matches), so the old
// firmware must come back, with no pending record and no rollback.
export default {
  name: 'ota-power-cut',
  issue: '#343',
  title: 'reset mid-download → the old firmware boots, nothing pending',
  expectsReconnect: true,
  steps: [
    { assertState: { state: 'READY' } },
    { send: 'T server firmware ingest good', expect: /^ok server$/ },
    { waitServer: /"event":"v2\.hil_command".*"outcome":"ingested/, timeoutMs: 15_000 },
    { send: 'T bridge reset', expect: /^ok bridge$/ },
    { waitDevice: /INFO v2\.ota_offer .*to=99\.0\.0/, timeoutMs: 120_000 },
    { waitDevice: /INFO v2\.ota_start .*to=99\.0\.0/, timeoutMs: 300_000 },
    { sleep: 4000 },
    { send: 'T bridge reset', expect: /^ok bridge$/ },
    { waitDevice: /INFO v2\.boot state=\S+ fw=(?!99\.)\S+/, timeoutMs: 20_000 },
    { waitDevice: /INFO v2\.ota_boot .*gate=0,/, timeoutMs: 20_000 },
    { waitDevice: /INFO v2\.welcome_accepted /, timeoutMs: 120_000 },
    { assertState: { state: 'READY' }, timeoutMs: 60_000 },
  ],
};
