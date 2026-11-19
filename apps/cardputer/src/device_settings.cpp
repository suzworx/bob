// Bob Cardputer v2 — the device's settings store at runtime (see include/device_settings.h).
#include "device_settings.h"

#include <cstring>
#include <memory>
#include <new>

#include "config.h"
#include "device_token.h"
#include "journal.h"
#include "net_store.h"
#include "settings_migration.h"

// Production is TLS on 443, always; the constant is not configurable.
static_assert(bob::kProdPort == 443, "production is wss:// on 443");
#if !BOB_DEV_OPTIONS && defined(BOB_LEGACY_SECRET)
#error "BOB_LEGACY_SECRET is a developer-only credential; build with BOB_DEV_OPTIONS=1"
#endif

namespace bob {

namespace {

Profile g_profile = Profile::kProd;
Endpoint g_endpoint{};
bool g_hasNetwork = false;

}  // namespace

void deviceSettingsBegin() {
  KvStore& kv = deviceStore();
  const MigrationSeed seed{kDevOptions, WIFI_SSID, WIFI_PASSWORD, V2_HOST,
                           static_cast<uint16_t>(V2_PORT), V2_USE_TLS != 0};
  const MigrationReport report = settingsMigrate(kv, seed);
  if (report.net || report.srv) {
    journal("settings_migrated", State::kBoot, "",
            String("net=") + (report.net ? 1 : 0) + " srv=" + (report.srv ? 1 : 0) +
                " seeded=" + (report.seededNetwork ? 1 : 0) + " token_profile=" +
                (report.tokenCopied ? profileName(report.profile) : "none"));
  }

  deviceSettingsReloadProfile();

  char ssid[kSsidMaxBytes + 1];
  char pass[kPassMaxBytes + 1];
  g_hasNetwork = firstSavedNetwork(ssid, sizeof(ssid), pass, sizeof(pass)) != kNoSlot;
  memset(pass, 0, sizeof(pass));
}

void deviceSettingsReloadProfile() {
  KvStore& kv = deviceStore();
  g_profile = profileLoad(kv, kDevOptions);
  if (!endpointLoad(kv, g_profile, kDevOptions, g_endpoint)) {
    g_profile = Profile::kProd;
    g_endpoint = prodEndpoint();
  }
  // A stored profile this build may not use (a plain endpoint on a build
  // without developer options, a locked profile, a bad endpoint) falls back
  // to Production, safely, and says so (#679).
  uint8_t stored = 0;
  if (kv.getU8(kSrvNamespace, "profile", &stored) && stored != static_cast<uint8_t>(g_profile)) {
    journal("profile_refused", State::kBoot, "",
            String("profile=") + (stored < kProfileCount ? profileName(static_cast<Profile>(stored)) : "unknown") +
                " reason=" + (kDevOptions ? "invalid_endpoint" : "not_allowed_on_this_build"));
  }
}

Profile activeProfile() { return g_profile; }

const Endpoint& activeEndpoint() { return g_endpoint; }

bool configured() { return g_hasNetwork && g_endpoint.host[0] != '\0'; }

uint8_t firstSavedNetwork(char* ssid, size_t ssidSize, char* pass, size_t passSize) {
  if (!ssid || !pass || ssidSize == 0 || passSize == 0) return kNoSlot;
  ssid[0] = '\0';
  pass[0] = '\0';
  std::unique_ptr<NetworkList> list(new (std::nothrow) NetworkList);
  if (!list) return kNoSlot;
  netLoad(deviceStore(), *list);
  if (list->count == 0) return kNoSlot;
  const uint8_t slot = list->order[0];
  strncpy(ssid, list->slot[slot].ssid, ssidSize - 1);
  ssid[ssidSize - 1] = '\0';
  strncpy(pass, list->slot[slot].pass, passSize - 1);
  pass[passSize - 1] = '\0';
  memset(list.get(), 0, sizeof(NetworkList));  // no stray passwords on the heap
  return slot;
}

bool hasDeviceToken() { return tokenHas(deviceStore(), g_profile); }

bool loadDeviceToken(char* out, size_t outSize) {
  return tokenLoad(deviceStore(), g_profile, out, outSize);
}

bool saveDeviceToken(const char* token) { return tokenSave(deviceStore(), g_profile, token); }

void eraseDeviceToken() { tokenErase(deviceStore(), g_profile); }

}  // namespace bob
