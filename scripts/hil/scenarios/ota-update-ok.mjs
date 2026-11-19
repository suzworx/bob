// Epic #343 (OTA-6): the real update. The server ingests a release signed
// with the fw-hil key (trusted only by dev builds) at 99.0.0; the device is
// offered it on hello, waits out the idle time and the countdown, downloads
// and verifies it, reboots into it pending verify, and confirms it only after
// a welcome and a quiet minute. The next hello then reports last_ota=ok.
export default {
  name: 'ota-update-ok',
  issue: '#343',
  title: 'offer → idle → countdown → download → reboot → health gate → last_ota=ok',
  expectsReconnect: true,
  steps: [
    { assertState: { state: 'READY' } },
    { send: 'T server firmware ingest good', expect: /^ok server$/ },
    { waitServer: /"event":"v2\.hil_command".*"outcome":"ingested/, timeoutMs: 15_000 },
    { send: 'T bridge reset', expect: /^ok bridge$/ },
    { waitDevice: /INFO v2\.ota_offer .*to=99\.0\.0/, timeoutMs: 120_000 },
    { waitDevice: /INFO v2\.ota_start .*to=99\.0\.0/, timeoutMs: 300_000 },
    { waitServer: /"event":"v2\.ota\.download".*"status":"completed"/, timeoutMs: 300_000 },
    { waitDevice: /INFO v2\.ota_reboot .*to=99\.0\.0/, timeoutMs: 60_000 },
    { waitDevice: /INFO v2\.boot state=\S+ fw=99\.0\.0/, timeoutMs: 60_000 },
    { waitDevice: /INFO v2\.ota_boot .*gate=1/, timeoutMs: 10_000 },
    { waitDevice: /INFO v2\.welcome_accepted /, timeoutMs: 120_000 },
    { waitDevice: /INFO v2\.ota_valid .*fw=99\.0\.0/, timeoutMs: 120_000 },
    { send: 'T bridge reset', expect: /^ok bridge$/ },
    { waitDevice: /INFO v2\.ota_boot .*gate=0,last=ok/, timeoutMs: 30_000 },
    { waitServer: /"event":"v2\.ota\.result".*"result":"ok"/, timeoutMs: 60_000 },
    { assertState: { state: 'READY' }, timeoutMs: 30_000 },
  ],
};
