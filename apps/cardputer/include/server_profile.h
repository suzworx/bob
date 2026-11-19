// Bob Cardputer v2 — which Bob server the device talks to (#675; pure over
// KvStore, host-tested). Production is a compile-time constant and is never
// stored, so no bad write can break the default. Dev and Custom endpoints live
// in NVS namespace "bob_srv". Developer builds (BOB_DEV_OPTIONS) may use
// every profile and plain ws://; other builds use Production, or a TLS-only
// Custom host once developer options are unlocked.
#pragma once

#include <cstddef>
#include <cstdint>

#include "kv_store.h"
#include "settings_rules.h"

namespace bob {

// Stored as a u8. Append, never renumber.
enum class Profile : uint8_t { kProd = 0, kDev = 1, kCustom = 2 };
constexpr uint8_t kProfileCount = 3;

constexpr char kSrvNamespace[] = "bob_srv";
constexpr uint8_t kSrvSchema = 1;
constexpr char kProdHost[] = "api.heybob.xyz";
constexpr uint16_t kProdPort = 443;

struct Endpoint {
  char host[kHostMaxBytes + 1];
  uint16_t port;
  bool tls;
};

enum class ProfileError : uint8_t {
  kOk,
  kInvalidHost,
  kInvalidPort,
  kPlainRefused,  // tls=0 on a build without developer options
  kLocked,        // profile not available on this build / not unlocked
  kImmutable,     // Production's endpoint cannot be edited
};

// "prod" | "dev" | "custom": the only form a journal line uses.
const char* profileName(Profile profile);

Endpoint prodEndpoint();

// Pure: may `profile` use `endpoint` on this build?
ProfileError endpointCheck(Profile profile, const Endpoint& endpoint, bool devOptions);

// Pure over the store: is `profile` selectable on this build?
bool profileAvailable(KvStore& kv, Profile profile, bool devOptions);

// The stored endpoint of `profile` (Production: the constant). False when a
// Dev/Custom endpoint is missing or fails endpointCheck.
bool endpointLoad(KvStore& kv, Profile profile, bool devOptions, Endpoint& out);

// The stored profile, falling back to Production when it is unavailable on
// this build or its endpoint is missing or invalid.
Profile profileLoad(KvStore& kv, bool devOptions);

// Validates, then writes `edit` (when non-null) as the profile's endpoint and
// selects the profile. Nothing is written on an error.
ProfileError profileSave(KvStore& kv, Profile profile, const Endpoint* edit, bool devOptions);

// Developer options on a build without them (#679): typing `developer` on
// About unlocks the Custom profile (TLS only). Cleared by factory reset.
bool profileUnlocked(KvStore& kv);
bool profileSetUnlocked(KvStore& kv, bool unlocked);

// Feeds one key typed on About to the `developer` matcher; `typedLen` is the
// caller's progress (start at 0). True when the key completes the word, which
// restarts the match. Any other key restarts it too.
inline bool profileUnlockKey(uint8_t& typedLen, char key) {
  static constexpr char kWord[] = "developer";
  // No proper prefix of the word recurs inside it, so a mismatch restarts at
  // 0, or at 1 when the key is the word's first letter.
  typedLen = key == kWord[typedLen] ? typedLen + 1 : (key == 'd' ? 1 : 0);
  if (typedLen < sizeof(kWord) - 1) return false;
  typedLen = 0;
  return true;
}

// For the screen only (never the journal): "Production", "Local dev", "Custom".
const char* profileDisplayName(Profile profile);

// Back to Production: clears every stored endpoint and the unlock, keeps the
// schema (tokens are elsewhere and are kept).
bool profileEraseAll(KvStore& kv);

}  // namespace bob
