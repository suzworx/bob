// Bob Cardputer v2 — first boot of the #675 settings store (see include/settings_migration.h).
#include "settings_migration.h"

#include <cstring>
#include <memory>
#include <new>

#include "device_token.h"
#include "net_store.h"
#include "types.h"

namespace bob {

namespace {

constexpr char kSchemaKey[] = "schema";

bool hasSchema(KvStore& kv, const char* ns) {
  uint8_t schema = 0;
  return kv.getU8(ns, kSchemaKey, &schema) && schema >= 1;
}

// The profile the compiled host points at: Production when it is exactly the
// production endpoint, otherwise Dev (written as the Dev endpoint).
Profile seedProfile(KvStore& kv, const MigrationSeed& seed) {
  if (!seed.devOptions || !seed.host || !hostValid(seed.host) || !portValid(seed.port)) {
    return Profile::kProd;
  }
  if (strcmp(seed.host, kProdHost) == 0 && seed.port == kProdPort && seed.tls) {
    return Profile::kProd;
  }
  Endpoint dev{};
  strncpy(dev.host, seed.host, sizeof(dev.host) - 1);
  dev.port = seed.port;
  dev.tls = seed.tls;
  return profileSave(kv, Profile::kDev, &dev, seed.devOptions) == ProfileError::kOk ? Profile::kDev
                                                                                     : Profile::kProd;
}

bool copyLegacyToken(KvStore& kv, Profile profile) {
  if (tokenHas(kv, profile)) return false;
  char token[kDeviceTokenBytes];
  const size_t len = kv.bytesLength(kTokenNamespace, kLegacyTokenKey);
  if (len == 0 || len >= sizeof(token)) return false;
  if (kv.getBytes(kTokenNamespace, kLegacyTokenKey, token, len) != len) return false;
  token[len] = '\0';
  return tokenSave(kv, profile, token);
}

}  // namespace

MigrationReport settingsMigrate(KvStore& kv, const MigrationSeed& seed) {
  MigrationReport report{};
  report.profile = Profile::kProd;

  if (!hasSchema(kv, kSrvNamespace)) {
    report.srv = true;
    report.profile = seedProfile(kv, seed);
    kv.putU8(kSrvNamespace, "profile", static_cast<uint8_t>(report.profile));
    report.tokenCopied = copyLegacyToken(kv, report.profile);
    kv.putU8(kSrvNamespace, kSchemaKey, kSrvSchema);
  }

  if (!hasSchema(kv, kNetNamespace)) {
    report.net = true;
    if (seed.devOptions && seed.ssid && seed.pass && ssidValid(seed.ssid) && passValid(seed.pass)) {
      std::unique_ptr<NetworkList> list(new (std::nothrow) NetworkList);
      if (list) {
        netClear(*list);
        report.seededNetwork =
            netAdd(*list, seed.ssid, seed.pass, kNetFlagSeeded, nullptr) == NetError::kOk &&
            netSave(kv, *list);
      }
    }
    kv.putU8(kNetNamespace, kSchemaKey, kNetSchema);
  }
  return report;
}

}  // namespace bob
