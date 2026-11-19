// Bob Cardputer v2 — which Bob server the device talks to (see include/server_profile.h).
#include "server_profile.h"

#include <cstring>

namespace bob {

namespace {

constexpr char kSchemaKey[] = "schema";
constexpr char kProfileKey[] = "profile";
constexpr char kUnlockKey[] = "unlock";

struct EndpointKeys {
  const char* host;
  const char* port;
  const char* tls;
};

// Production has no keys: it is never stored.
bool keysFor(Profile profile, EndpointKeys& out) {
  switch (profile) {
    case Profile::kDev: out = {"dev_host", "dev_port", "dev_tls"}; return true;
    case Profile::kCustom: out = {"cus_host", "cus_port", "cus_tls"}; return true;
    case Profile::kProd: break;
  }
  return false;
}

bool unlocked(KvStore& kv) {
  uint8_t value = 0;
  return kv.getU8(kSrvNamespace, kUnlockKey, &value) && value == 1;
}

}  // namespace

const char* profileName(Profile profile) {
  switch (profile) {
    case Profile::kProd: return "prod";
    case Profile::kDev: return "dev";
    case Profile::kCustom: return "custom";
  }
  return "prod";
}

Endpoint prodEndpoint() {
  Endpoint endpoint{};
  strncpy(endpoint.host, kProdHost, sizeof(endpoint.host) - 1);
  endpoint.port = kProdPort;
  endpoint.tls = true;
  return endpoint;
}

ProfileError endpointCheck(Profile profile, const Endpoint& endpoint, bool devOptions) {
  if (profile == Profile::kProd) return ProfileError::kImmutable;
  if (!hostValid(endpoint.host)) return ProfileError::kInvalidHost;
  if (!portValid(endpoint.port)) return ProfileError::kInvalidPort;
  if (!endpoint.tls && !devOptions) return ProfileError::kPlainRefused;
  return ProfileError::kOk;
}

bool profileAvailable(KvStore& kv, Profile profile, bool devOptions) {
  switch (profile) {
    case Profile::kProd: return true;
    case Profile::kDev: return devOptions;
    case Profile::kCustom: return devOptions || unlocked(kv);
  }
  return false;
}

bool endpointLoad(KvStore& kv, Profile profile, bool devOptions, Endpoint& out) {
  if (profile == Profile::kProd) {
    out = prodEndpoint();
    return true;
  }
  EndpointKeys keys{};
  if (!keysFor(profile, keys)) return false;
  Endpoint endpoint{};
  uint8_t tls = 1;
  if (!kvGetString(kv, kSrvNamespace, keys.host, endpoint.host, sizeof(endpoint.host)) ||
      !kv.getU16(kSrvNamespace, keys.port, &endpoint.port)) {
    return false;
  }
  kv.getU8(kSrvNamespace, keys.tls, &tls);
  endpoint.tls = tls != 0;
  if (endpointCheck(profile, endpoint, devOptions) != ProfileError::kOk) return false;
  out = endpoint;
  return true;
}

Profile profileLoad(KvStore& kv, bool devOptions) {
  uint8_t stored = 0;
  if (!kv.getU8(kSrvNamespace, kProfileKey, &stored) || stored >= kProfileCount) {
    return Profile::kProd;
  }
  const Profile profile = static_cast<Profile>(stored);
  Endpoint endpoint{};
  if (!profileAvailable(kv, profile, devOptions) || !endpointLoad(kv, profile, devOptions, endpoint)) {
    return Profile::kProd;
  }
  return profile;
}

ProfileError profileSave(KvStore& kv, Profile profile, const Endpoint* edit, bool devOptions) {
  if (!profileAvailable(kv, profile, devOptions)) return ProfileError::kLocked;
  if (profile == Profile::kProd) {
    if (edit) return ProfileError::kImmutable;
  } else if (edit) {
    const ProfileError bad = endpointCheck(profile, *edit, devOptions);
    if (bad != ProfileError::kOk) return bad;
    EndpointKeys keys{};
    keysFor(profile, keys);
    kvPutString(kv, kSrvNamespace, keys.host, edit->host);
    kv.putU16(kSrvNamespace, keys.port, edit->port);
    kv.putU8(kSrvNamespace, keys.tls, edit->tls ? 1 : 0);
  } else {
    Endpoint current{};
    if (!endpointLoad(kv, profile, devOptions, current)) return ProfileError::kInvalidHost;
  }
  kv.putU8(kSrvNamespace, kProfileKey, static_cast<uint8_t>(profile));
  return ProfileError::kOk;
}

bool profileUnlocked(KvStore& kv) { return unlocked(kv); }

bool profileSetUnlocked(KvStore& kv, bool value) {
  return value ? kv.putU8(kSrvNamespace, kUnlockKey, 1) : kv.remove(kSrvNamespace, kUnlockKey);
}

const char* profileDisplayName(Profile profile) {
  switch (profile) {
    case Profile::kProd: return "Production";
    case Profile::kDev: return "Local dev";
    case Profile::kCustom: return "Custom";
  }
  return "Production";
}

bool profileEraseAll(KvStore& kv) {
  const bool cleared = kv.clear(kSrvNamespace);
  return kv.putU8(kSrvNamespace, kSchemaKey, kSrvSchema) && cleared;
}

}  // namespace bob
