// Bob Cardputer v2 — first boot of the #675 settings store (pure over KvStore,
// host-tested). Runs once per namespace, before Wi-Fi: a device flashed before
// #675 keeps its compiled network and its pairing with zero taps. Each
// namespace's schema key is written last, so an interrupted migration simply
// runs again. A namespace that already has a schema is never touched, so a
// seeded network the user forgot is not re-seeded.
#pragma once

#include <cstdint>

#include "kv_store.h"
#include "server_profile.h"

namespace bob {

// The compiled-in values (secrets.h). Used only on developer builds.
struct MigrationSeed {
  bool devOptions;
  const char* ssid;
  const char* pass;
  const char* host;
  uint16_t port;
  bool tls;
};

struct MigrationReport {
  bool net;            // bob_net was initialised on this boot
  bool srv;            // bob_srv was initialised on this boot
  bool seededNetwork;  // slot 0 came from the seed
  bool tokenCopied;    // the legacy dev_tok was copied to tokenProfile
  Profile profile;     // the profile selected by the migration (srv only)
};

MigrationReport settingsMigrate(KvStore& kv, const MigrationSeed& seed);

}  // namespace bob
