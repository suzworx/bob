// Bob Cardputer v2 — the reset options (see include/reset_actions.h).
#include "reset_actions.h"

#include "device_token.h"
#include "net_store.h"
#include "settings.h"

namespace bob {

const char* resetScopeName(ResetScope scope) {
  switch (scope) {
    case ResetScope::kWifi: return "wifi";
    case ResetScope::kServer: return "server";
    case ResetScope::kUnpair: return "unpair";
    case ResetScope::kFactory: return "factory";
  }
  return "wifi";
}

namespace {

DriverWifiEraseFn g_driverWifiEraser = nullptr;

bool applyStores(KvStore& kv, ResetScope scope, Profile activeProfile) {
  switch (scope) {
    case ResetScope::kWifi: return netEraseAll(kv);
    case ResetScope::kServer: return profileEraseAll(kv);
    case ResetScope::kUnpair: return tokenErase(kv, activeProfile);
    case ResetScope::kFactory: {
      // Schemas go too: the next boot is a first boot (migration, Setup).
      bool ok = kv.clear(kNetNamespace);
      ok = kv.clear(kSrvNamespace) && ok;
      ok = tokenEraseAll(kv) && ok;
      ok = kv.clear(kSettingsNamespace) && ok;
      return ok;
    }
  }
  return false;
}

}  // namespace

bool resetErasesDriverWifi(ResetScope scope) {
  return scope == ResetScope::kWifi || scope == ResetScope::kFactory;
}

void resetSetDriverWifiEraser(DriverWifiEraseFn eraser) { g_driverWifiEraser = eraser; }

bool resetApply(KvStore& kv, ResetScope scope, Profile activeProfile) {
  bool ok = applyStores(kv, scope, activeProfile);
  if (resetErasesDriverWifi(scope) && g_driverWifiEraser) ok = g_driverWifiEraser() && ok;
  return ok;
}

}  // namespace bob
