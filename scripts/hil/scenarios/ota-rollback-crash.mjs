// Epic #343 (OTA-6): the first real rollback. 99.0.1 is built with
// BOB_OTA_TEST_CRASH, so it aborts at boot while still pending verify. The
// bootloader must return to the previous slot (99.0.0, installed by
// ota-update-ok); that image sees its own pending record, reports
// last_ota=rolled_back, and the server journals the result.
export default {
  name: 'ota-rollback-crash',
  issue: '#343',
  title: 'new image crashes before the health gate → bootloader returns to the old slot → rolled_back',
  expectsReconnect: true,
  steps: [
    { assertState: { state: 'READY' } },
    { send: 'T server firmware ingest crash', expect: /^ok server$/ },
    { waitServer: /"event":"v2\.hil_command".*"outcome":"ingested/, timeoutMs: 15_000 },
    { send: 'T bridge reset', expect: /^ok bridge$/ },
    { waitDevice: /INFO v2\.ota_offer .*to=99\.0\.1/, timeoutMs: 120_000 },
    { waitDevice: /INFO v2\.ota_start .*to=99\.0\.1/, timeoutMs: 300_000 },
    { waitDevice: /INFO v2\.ota_reboot .*to=99\.0\.1/, timeoutMs: 300_000 },
    { waitDevice: /INFO v2\.ota_boot .*gate=1/, timeoutMs: 10_000 },
    { waitDevice: /INFO v2\.boot state=\S+ fw=99\.0\.0/, timeoutMs: 60_000 },
    { waitDevice: /INFO v2\.ota_boot .*gate=0,last=rolled_back/, timeoutMs: 10_000 },
    { waitServer: /"event":"v2\.ota\.result".*"result":"rolled_back"/, timeoutMs: 60_000 },
    { waitDevice: /INFO v2\.welcome_accepted /, timeoutMs: 120_000 },
    { assertState: { state: 'READY' }, timeoutMs: 30_000 },
  ],
};
