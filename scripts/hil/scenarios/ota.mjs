import otaPowerCut from './ota-power-cut.mjs';
import otaRollbackCrash from './ota-rollback-crash.mjs';
import otaUpdateOk from './ota-update-ok.mjs';

// Run only by `node scripts/hil/run.mjs --ota`, in this order: the rollback
// scenario starts from the 99.0.0 image the update scenario installs. They
// replace the device's firmware, so they are never part of the attested set.
export const OTA_SCENARIOS = [otaPowerCut, otaUpdateOk, otaRollbackCrash];
