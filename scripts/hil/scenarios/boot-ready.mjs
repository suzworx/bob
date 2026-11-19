// The device boots, pairs with (or authenticates to) the HIL server, is
// welcomed, and sits in READY with its test console answering. It then gets a
// known baseline for every later scenario: push-to-talk (announce_only blocks
// GO turns) and DND off (DND holds announcements). Both persist in NVS, so a
// device left in another mode would otherwise change what later scenarios see.
//
// Opening the USB serial port can reset an ESP32-S3 (it did on the first open
// after a flash, run 20260923-224909-298e), so a welcome seen before the
// console handshake may belong to a boot that is already gone. The scenario
// therefore resets the device itself after the handshake and proves the fresh
// boot: every wait below only matches lines after that reset.
//
// The firmware version is SemVer from the build (#345): x.y.z for a release,
// x.y.z-dev+<sha> for a local build, x.y.z-dev with no sha. A missing or
// malformed version still fails the match.
const IDS = '[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*';
const FW_VERSION = `\\d+\\.\\d+\\.\\d+(?:-${IDS})?(?:\\+${IDS})?`;

export default {
  name: 'boot-ready',
  issue: '#baseline',
  title: 'reset → boot → welcome → READY, baseline mode=ptt dnd=0',
  steps: [
    { send: 'T ping', expect: new RegExp(`^pong fw=${FW_VERSION} build=\\S+ id=[0-9a-f]{12}$`), timeoutMs: 30_000 },
    { send: 'T bridge reset', expect: /^ok bridge$/ },
    // The boot line names the firmware that is flashed (CP-WAKE-FOLLOWUP).
    { waitDevice: new RegExp(`INFO v2\\.boot state=\\S+ fw=${FW_VERSION} build=[0-9a-z]+$`), timeoutMs: 15_000 },
    // A fresh HIL database does not know the device's saved token, so the
    // first connect pairs (the server harness auto-approves), then reconnects.
    { waitDevice: /INFO v2\.welcome_accepted /, timeoutMs: 120_000 },
    { waitServer: /"event":"v2\.welcome"/, timeoutMs: 10_000 },
    { assertState: { state: 'READY' }, timeoutMs: 120_000 },
    { send: 'T server control mode=ptt dnd=0', expect: /^ok server$/ },
    { waitServer: /"event":"v2\.hil_command".*"outcome":"sent_[1-9]"/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.device_control_applied .*mode=ptt,dnd=0/, timeoutMs: 5000 },
    { assertState: { state: 'READY', mode: 'ptt', dnd: 0 }, timeoutMs: 5000 },
  ],
};
