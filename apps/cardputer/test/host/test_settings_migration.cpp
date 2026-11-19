// Server profiles, per-profile device tokens and the first-boot migration
// (#675): a pre-#675 device keeps its network and pairing, a dev server never
// erases the production token, and non-developer builds refuse plain ws://.
#include <memory>
#include <string>

#include "device_token.h"
#include "doctest.h"
#include "fake_kv.h"
#include "net_store.h"
#include "server_profile.h"
#include "settings_migration.h"
#include "types.h"

using namespace bob;

namespace {

constexpr char kToken[] = "olxd_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

MigrationSeed devSeed(const char* host, uint16_t port, bool tls) {
  return MigrationSeed{true, "HomeNet", "password1", host, port, tls};
}

Endpoint endpoint(const char* host, uint16_t port, bool tls) {
  Endpoint e{};
  strncpy(e.host, host, sizeof(e.host) - 1);
  e.port = port;
  e.tls = tls;
  return e;
}

std::unique_ptr<NetworkList> load(hosttest::FakeKv& kv) {
  auto list = std::make_unique<NetworkList>();
  netLoad(kv, *list);
  return list;
}

}  // namespace

TEST_CASE("production is a constant: wss on 443, never stored, never editable") {
  hosttest::FakeKv kv;
  Endpoint e{};
  REQUIRE(endpointLoad(kv, Profile::kProd, false, e));
  CHECK(std::string(e.host) == "api.heybob.xyz");
  CHECK(e.port == 443);
  CHECK(e.tls);
  const Endpoint edit = endpoint("evil.example", 443, true);
  CHECK(profileSave(kv, Profile::kProd, &edit, true) == ProfileError::kImmutable);
  CHECK(profileLoad(kv, true) == Profile::kProd);
}

TEST_CASE("developer builds may use dev over plain ws://; other builds may not") {
  hosttest::FakeKv kv;
  const Endpoint dev = endpoint("devbox", 7444, false);
  CHECK(profileSave(kv, Profile::kDev, &dev, false) == ProfileError::kLocked);
  CHECK(profileSave(kv, Profile::kDev, &dev, true) == ProfileError::kOk);
  CHECK(profileLoad(kv, true) == Profile::kDev);
  // The same NVS on a Production-only build falls back to Production.
  CHECK(profileLoad(kv, false) == Profile::kProd);
}

TEST_CASE("custom needs an unlock and TLS on non-developer builds") {
  hosttest::FakeKv kv;
  const Endpoint plain = endpoint("host.example", 443, false);
  const Endpoint secure = endpoint("host.example", 443, true);
  CHECK(profileSave(kv, Profile::kCustom, &secure, false) == ProfileError::kLocked);
  kv.putU8(kSrvNamespace, "unlock", 1);
  CHECK(profileSave(kv, Profile::kCustom, &plain, false) == ProfileError::kPlainRefused);
  CHECK(profileSave(kv, Profile::kCustom, &secure, false) == ProfileError::kOk);
  CHECK(profileLoad(kv, false) == Profile::kCustom);
}

TEST_CASE("a tampered plain endpoint never loads on a non-developer build") {
  hosttest::FakeKv kv;
  kv.putU8(kSrvNamespace, "unlock", 1);
  kv.putString(kSrvNamespace, "cus_host", "host.example");
  kv.putU16(kSrvNamespace, "cus_port", 80);
  kv.putU8(kSrvNamespace, "cus_tls", 0);
  kv.putU8(kSrvNamespace, "profile", static_cast<uint8_t>(Profile::kCustom));
  Endpoint e{};
  CHECK_FALSE(endpointLoad(kv, Profile::kCustom, false, e));
  CHECK(profileLoad(kv, false) == Profile::kProd);
}

TEST_CASE("invalid endpoints are refused before anything is written") {
  hosttest::FakeKv kv;
  const Endpoint badHost = endpoint("ws://devbox", 7444, false);
  const Endpoint badPort = endpoint("devbox", 0, false);
  CHECK(profileSave(kv, Profile::kDev, &badHost, true) == ProfileError::kInvalidHost);
  CHECK(profileSave(kv, Profile::kDev, &badPort, true) == ProfileError::kInvalidPort);
  CHECK(kv.keys(kSrvNamespace).empty());
}

TEST_CASE("tokens are per profile: erasing dev keeps prod, and the reverse") {
  hosttest::FakeKv kv;
  REQUIRE(tokenSave(kv, Profile::kProd, kToken));
  REQUIRE(tokenSave(kv, Profile::kDev, kToken));
  REQUIRE(tokenErase(kv, Profile::kDev));
  CHECK(tokenHas(kv, Profile::kProd));
  CHECK_FALSE(tokenHas(kv, Profile::kDev));
  char out[kDeviceTokenBytes];
  REQUIRE(tokenLoad(kv, Profile::kProd, out, sizeof(out)));
  CHECK(std::string(out) == kToken);
  // #675: a Production revoke leaves a dev pairing too.
  REQUIRE(tokenSave(kv, Profile::kDev, kToken));
  REQUIRE(tokenErase(kv, Profile::kProd));
  CHECK_FALSE(tokenHas(kv, Profile::kProd));
  CHECK(tokenHas(kv, Profile::kDev));
}

TEST_CASE("token size limits hold") {
  hosttest::FakeKv kv;
  CHECK_FALSE(tokenSave(kv, Profile::kProd, ""));
  CHECK_FALSE(tokenSave(kv, Profile::kProd, std::string(kDeviceTokenBytes, 'x').c_str()));
  CHECK(tokenSave(kv, Profile::kProd, std::string(kDeviceTokenBytes - 1, 'x').c_str()));
}

TEST_CASE("migration: a factory-fresh developer build seeds network and dev server") {
  hosttest::FakeKv kv;
  const MigrationReport r = settingsMigrate(kv, devSeed("devbox", 7444, false));
  CHECK(r.net);
  CHECK(r.srv);
  CHECK(r.seededNetwork);
  CHECK_FALSE(r.tokenCopied);
  CHECK(r.profile == Profile::kDev);
  auto list = load(kv);
  REQUIRE(list->count == 1);
  CHECK(std::string(list->slot[list->order[0]].ssid) == "HomeNet");
  CHECK((list->slot[list->order[0]].flags & kNetFlagSeeded) != 0);
  Endpoint e{};
  REQUIRE(endpointLoad(kv, Profile::kDev, true, e));
  CHECK(std::string(e.host) == "devbox");
  CHECK(profileLoad(kv, true) == Profile::kDev);
}

TEST_CASE("migration: an upgraded dev device keeps its pairing (legacy token copied, not moved)") {
  hosttest::FakeKv kv;
  kv.putString(kTokenNamespace, kLegacyTokenKey, kToken);
  const MigrationReport r = settingsMigrate(kv, devSeed("devbox", 7444, false));
  CHECK(r.tokenCopied);
  CHECK(r.profile == Profile::kDev);
  CHECK(kv.getString(kTokenNamespace, "tok_dev") == kToken);
  CHECK_FALSE(tokenHas(kv, Profile::kProd));
  CHECK(kv.getString(kTokenNamespace, kLegacyTokenKey) == kToken);  // rollback still paired
}

TEST_CASE("migration: a build pointed at production maps to the prod profile") {
  hosttest::FakeKv kv;
  kv.putString(kTokenNamespace, kLegacyTokenKey, kToken);
  const MigrationReport r = settingsMigrate(kv, devSeed("api.heybob.xyz", 443, true));
  CHECK(r.profile == Profile::kProd);
  CHECK(tokenHas(kv, Profile::kProd));
  CHECK_FALSE(kv.has(kSrvNamespace, "dev_host"));
}

TEST_CASE("migration: production host without TLS is treated as dev, never as prod") {
  hosttest::FakeKv kv;
  const MigrationReport r = settingsMigrate(kv, devSeed("api.heybob.xyz", 443, false));
  CHECK(r.profile == Profile::kDev);
}

TEST_CASE("migration: a non-developer build seeds nothing and uses production") {
  hosttest::FakeKv kv;
  MigrationSeed seed = devSeed("devbox", 7444, false);
  seed.devOptions = false;
  const MigrationReport r = settingsMigrate(kv, seed);
  CHECK_FALSE(r.seededNetwork);
  CHECK(r.profile == Profile::kProd);
  CHECK(load(kv)->count == 0);
  CHECK(profileLoad(kv, false) == Profile::kProd);
}

TEST_CASE("migration: empty secrets seed nothing") {
  hosttest::FakeKv kv;
  const MigrationReport r = settingsMigrate(kv, MigrationSeed{true, "", "", "", 7444, false});
  CHECK(r.net);
  CHECK_FALSE(r.seededNetwork);
  CHECK(r.profile == Profile::kProd);
}

TEST_CASE("migration runs once: a forgotten seed network is not re-seeded") {
  hosttest::FakeKv kv;
  settingsMigrate(kv, devSeed("devbox", 7444, false));
  REQUIRE(netEraseAll(kv));
  const MigrationReport again = settingsMigrate(kv, devSeed("devbox", 7444, false));
  CHECK_FALSE(again.net);
  CHECK_FALSE(again.srv);
  CHECK(load(kv)->count == 0);
}

TEST_CASE("migration runs once: a later pairing is not overwritten by the legacy token") {
  hosttest::FakeKv kv;
  kv.putString(kTokenNamespace, kLegacyTokenKey, kToken);
  settingsMigrate(kv, devSeed("devbox", 7444, false));
  const std::string fresh = "olxd_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  tokenSave(kv, Profile::kDev, fresh.c_str());
  settingsMigrate(kv, devSeed("devbox", 7444, false));
  CHECK(kv.getString(kTokenNamespace, "tok_dev") == fresh);
}

TEST_CASE("migration interrupted at every write still converges") {
  for (int budget = 0; budget < 30; ++budget) {
    CAPTURE(budget);
    hosttest::FakeKv kv;
    kv.putString(kTokenNamespace, kLegacyTokenKey, kToken);
    kv.writes = 0;
    kv.writeBudget = budget;  // power cut after `budget` writes
    settingsMigrate(kv, devSeed("devbox", 7444, false));
    kv.writeBudget = -1;  // next boot
    settingsMigrate(kv, devSeed("devbox", 7444, false));
    auto list = load(kv);
    CHECK(list->count == 1);
    CHECK(profileLoad(kv, true) == Profile::kDev);
    CHECK(kv.getString(kTokenNamespace, "tok_dev") == kToken);
    uint8_t schema = 0;
    CHECK(kv.getU8(kNetNamespace, "schema", &schema));
    CHECK(kv.getU8(kSrvNamespace, "schema", &schema));
  }
}

TEST_CASE("reset server to production keeps every token") {
  hosttest::FakeKv kv;
  settingsMigrate(kv, devSeed("devbox", 7444, false));
  tokenSave(kv, Profile::kProd, kToken);
  tokenSave(kv, Profile::kDev, kToken);
  REQUIRE(profileEraseAll(kv));
  CHECK(profileLoad(kv, true) == Profile::kProd);
  CHECK(tokenHas(kv, Profile::kProd));
  CHECK(tokenHas(kv, Profile::kDev));
  CHECK(kv.keys(kSrvNamespace) == std::vector<std::string>{"schema"});
}

TEST_CASE("developer options unlock: custom becomes available, TLS only, and locks again") {
  hosttest::FakeKv kv;
  CHECK_FALSE(profileUnlocked(kv));
  CHECK_FALSE(profileAvailable(kv, Profile::kCustom, false));
  REQUIRE(profileSetUnlocked(kv, true));
  CHECK(profileUnlocked(kv));
  CHECK(profileAvailable(kv, Profile::kCustom, false));
  CHECK_FALSE(profileAvailable(kv, Profile::kDev, false));  // Local dev stays developer-build only
  REQUIRE(profileSetUnlocked(kv, false));
  CHECK_FALSE(profileAvailable(kv, Profile::kCustom, false));
}

TEST_CASE("typing `developer` on About completes the unlock word, and only that word") {
  const auto completions = [](const char* typed) {
    uint8_t len = 0;
    int done = 0;
    for (const char* c = typed; *c; ++c) done += profileUnlockKey(len, *c) ? 1 : 0;
    return done;
  };
  CHECK(completions("developer") == 1);
  CHECK(completions("ddeveloper") == 1);    // a stray d restarts at d, not at nothing
  CHECK(completions("devdeveloper") == 1);
  CHECK(completions("developerdeveloper") == 2);  // twice toggles back off
  CHECK(completions("develope") == 0);
  CHECK(completions("develoXper") == 0);
  CHECK(completions("Developer") == 0);
  CHECK(completions("xdeveloperx") == 1);
}

TEST_CASE("release build: tampered or relocked NVS always boots Production") {
  hosttest::FakeKv kv;
  // A Local dev profile, even over TLS, is developer-build only.
  kv.putString(kSrvNamespace, "dev_host", "devbox");
  kv.putU16(kSrvNamespace, "dev_port", 443);
  kv.putU8(kSrvNamespace, "dev_tls", 1);
  kv.putU8(kSrvNamespace, "profile", static_cast<uint8_t>(Profile::kDev));
  CHECK(profileLoad(kv, false) == Profile::kProd);
  // An unknown profile byte.
  kv.putU8(kSrvNamespace, "profile", kProfileCount);
  CHECK(profileLoad(kv, false) == Profile::kProd);
  // Custom over TLS, but the unlock byte is not exactly 1.
  const Endpoint secure = endpoint("host.example", 443, true);
  kv.putU8(kSrvNamespace, "unlock", 1);
  REQUIRE(profileSave(kv, Profile::kCustom, &secure, false) == ProfileError::kOk);
  kv.putU8(kSrvNamespace, "unlock", 2);
  CHECK(profileLoad(kv, false) == Profile::kProd);
  // Locking developer options again while on Custom falls back too.
  REQUIRE(profileSetUnlocked(kv, true));
  CHECK(profileLoad(kv, false) == Profile::kCustom);
  REQUIRE(profileSetUnlocked(kv, false));
  CHECK(profileLoad(kv, false) == Profile::kProd);
}

TEST_CASE("display names are for the screen; journal names stay short") {
  CHECK(std::string(profileDisplayName(Profile::kDev)) == "Local dev");
  CHECK(std::string(profileName(Profile::kDev)) == "dev");
  CHECK(std::string(profileName(Profile::kCustom)) == "custom");
}
