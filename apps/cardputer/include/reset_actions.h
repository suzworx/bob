// Bob Cardputer v2 — the reset options (#680; pure over KvStore,
// host-tested). Each clears exactly its scope and nothing else:
//   wifi     every saved network (the schema stays, so the secrets.h seed is
//            not re-applied), and the Wi-Fi driver's own copy (#707)
//   server   the Dev/Custom endpoints and the developer-options unlock; back
//            to Production. Every pairing token is kept.
//   unpair   the active server profile's token only
//   factory  all of the above plus the sound settings: the device boots as
//            new (the caller restarts it)
#pragma once

#include <cstdint>

#include "kv_store.h"
#include "server_profile.h"

namespace bob {

// Stored nowhere; append, never renumber.
enum class ResetScope : uint8_t { kWifi, kServer, kUnpair, kFactory };

// "wifi" | "server" | "unpair" | "factory"
const char* resetScopeName(ResetScope scope);

// Also runs the driver-Wi-Fi eraser (below) for the scopes that need it.
bool resetApply(KvStore& kv, ResetScope scope, Profile activeProfile);

// The Wi-Fi driver keeps its own copy of the station network, apart from the
// saved networks; builds before #707 let it persist to flash. `wifi` and
// `factory` promise the password is gone, so both erase that copy too.
bool resetErasesDriverWifi(ResetScope scope);

// Erases the driver's station config (RAM and flash); false on failure. Set
// once by wifi_manager on the device; with none set, nothing runs (host).
using DriverWifiEraseFn = bool (*)();
void resetSetDriverWifiEraser(DriverWifiEraseFn eraser);

}  // namespace bob
