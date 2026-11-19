// The reset options (include/reset_actions.h, #680): each clears exactly its
// scope, checked as the full key set before and after on a fake NVS.
#include <memory>
#include <set>
#include <string>

#include "device_token.h"
#include "doctest.h"
#include "fake_kv.h"
#include "net_store.h"
#include "reset_actions.h"
#include "server_profile.h"
#include "settings.h"
#include "settings_migration.h"

using namespace bob;

namespace {

constexpr char kToken[] = "olxd_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

using KeySet = std::set<std::pair<std::string, std::string>>;

KeySet keys(const hosttest::FakeKv& kv) {
  KeySet out;
  for (const auto& [k, v] : kv.entries) out.insert(k);
  return out;
}

// A device with everything: two networks, a dev profile, a custom unlock,
// tokens for prod and dev, the legacy token and some sound settings.
hosttest::FakeKv everything() {
  hosttest::FakeKv kv;
  kv.putString(kTokenNamespace, kLegacyTokenKey, kToken);
  settingsMigrate(kv, MigrationSeed{true, "HomeNet", "password1", "devbox", 7444, false});
  auto list = std::make_unique<NetworkList>();
  netLoad(kv, *list);
  netAdd(*list, "Hotspot", "password2", 0, nullptr);
  netSave(kv, *list);
  tokenSave(kv, Profile::kProd, kToken);
  tokenSave(kv, Profile::kDev, kToken);
  profileSetUnlocked(kv, true);
  kv.putU8(kSettingsNamespace, "vol", 7);
  return kv;
}

KeySet only(const KeySet& all, const char* ns) {
  KeySet out;
  for (const auto& k : all) {
    if (k.first == ns) out.insert(k);
  }
  return out;
}

KeySet without(const KeySet& all, const char* ns) {
  KeySet out;
  for (const auto& k : all) {
    if (k.first != ns) out.insert(k);
  }
  return out;
}

}  // namespace

TEST_CASE("forget all Wi-Fi clears the networks and nothing else") {
  auto kv = everything();
  const KeySet before = keys(kv);
  REQUIRE(resetApply(kv, ResetScope::kWifi, Profile::kDev));
  const KeySet after = keys(kv);
  CHECK(without(after, kNetNamespace) == without(before, kNetNamespace));
  CHECK(only(after, kNetNamespace) == KeySet{{kNetNamespace, "schema"}});
}

TEST_CASE("reset server clears endpoints and the unlock, keeps every token") {
  auto kv = everything();
  const KeySet before = keys(kv);
  REQUIRE(resetApply(kv, ResetScope::kServer, Profile::kDev));
  const KeySet after = keys(kv);
  CHECK(without(after, kSrvNamespace) == without(before, kSrvNamespace));
  CHECK(only(after, kSrvNamespace) == KeySet{{kSrvNamespace, "schema"}});
  CHECK(profileLoad(kv, true) == Profile::kProd);
  CHECK(tokenHas(kv, Profile::kProd));
  CHECK(tokenHas(kv, Profile::kDev));
}

TEST_CASE("unpair clears only the active profile's token") {
  auto kv = everything();
  const KeySet before = keys(kv);
  REQUIRE(resetApply(kv, ResetScope::kUnpair, Profile::kDev));
  KeySet expected = before;
  expected.erase({kTokenNamespace, "tok_dev"});
  CHECK(keys(kv) == expected);
}

TEST_CASE("factory reset leaves no key at all: the next boot is a first boot") {
  auto kv = everything();
  REQUIRE(resetApply(kv, ResetScope::kFactory, Profile::kDev));
  CHECK(keys(kv).empty());
  // A retail build then seeds nothing and uses Production: Setup runs.
  const MigrationReport r = settingsMigrate(kv, MigrationSeed{false, "", "", "", 0, false});
  CHECK(r.net);
  CHECK(r.srv);
  CHECK_FALSE(r.seededNetwork);
  CHECK(r.profile == Profile::kProd);
}

namespace {

int g_driverErases = 0;
bool g_driverEraseOk = true;

bool fakeDriverErase() {
  ++g_driverErases;
  return g_driverEraseOk;
}

// Runs one scope with the fake driver eraser; returns how often it ran.
int driverErasesFor(ResetScope scope, bool* applied = nullptr) {
  auto kv = everything();
  g_driverErases = 0;
  resetSetDriverWifiEraser(fakeDriverErase);
  const bool ok = resetApply(kv, scope, Profile::kDev);
  resetSetDriverWifiEraser(nullptr);
  if (applied) *applied = ok;
  return g_driverErases;
}

}  // namespace

// #707 c1: the driver's own copy of the station network (flash, from older
// builds) goes with "forget all Wi-Fi" and the factory reset, never otherwise.
TEST_CASE("scope -> actions: wifi and factory also erase the driver's Wi-Fi copy") {
  CHECK(resetErasesDriverWifi(ResetScope::kWifi));
  CHECK(resetErasesDriverWifi(ResetScope::kFactory));
  CHECK_FALSE(resetErasesDriverWifi(ResetScope::kServer));
  CHECK_FALSE(resetErasesDriverWifi(ResetScope::kUnpair));
  CHECK(driverErasesFor(ResetScope::kWifi) == 1);
  CHECK(driverErasesFor(ResetScope::kFactory) == 1);
  CHECK(driverErasesFor(ResetScope::kServer) == 0);
  CHECK(driverErasesFor(ResetScope::kUnpair) == 0);
}

TEST_CASE("a failed driver erase fails the reset, but the stores are still cleared") {
  g_driverEraseOk = false;
  bool applied = true;
  CHECK(driverErasesFor(ResetScope::kFactory, &applied) == 1);
  CHECK_FALSE(applied);
  auto kv = everything();
  resetSetDriverWifiEraser(fakeDriverErase);
  CHECK_FALSE(resetApply(kv, ResetScope::kFactory, Profile::kDev));
  resetSetDriverWifiEraser(nullptr);
  CHECK(keys(kv).empty());
  g_driverEraseOk = true;
}

TEST_CASE("with no eraser set (host), a reset clears only the stores") {
  auto kv = everything();
  resetSetDriverWifiEraser(nullptr);
  CHECK(resetApply(kv, ResetScope::kFactory, Profile::kDev));
  CHECK(keys(kv).empty());
}

TEST_CASE("scope names are log-safe") {
  CHECK(std::string(resetScopeName(ResetScope::kFactory)) == "factory");
  CHECK(std::string(resetScopeName(ResetScope::kUnpair)) == "unpair");
}
