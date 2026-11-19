// Bob Cardputer v2 — NVS-backed paired device tokens, one per server profile.
// Namespace "bob", keys "tok_prod" / "tok_dev" / "tok_cus" (#675). Before
// #675 there was one key, "dev_tok": migration copies it to the profile the
// build was pointed at and leaves it in place, so older firmware still finds
// it after a rollback. A token is read at boot, sent as
// `Authorization: Bearer <token>` on every upgrade, and erased only when the
// server refuses it with pairing_required {reason: unknown|revoked} -- and
// then only the active profile's token, so a dev server never erases the
// production pairing.
#pragma once

#include <cstddef>

#include "kv_store.h"
#include "server_profile.h"

namespace bob {

constexpr char kTokenNamespace[] = "bob";
constexpr char kLegacyTokenKey[] = "dev_tok";

// Pure over KvStore (host-tested).
const char* tokenKey(Profile profile);
bool tokenHas(KvStore& kv, Profile profile);
bool tokenLoad(KvStore& kv, Profile profile, char* out, size_t outSize);
bool tokenSave(KvStore& kv, Profile profile, const char* token);
bool tokenErase(KvStore& kv, Profile profile);
// Every profile's token and the legacy key (factory reset).
bool tokenEraseAll(KvStore& kv);

// The device's NVS and active profile (src/device_settings.cpp).
// True when the active profile has a token.
bool hasDeviceToken();

// Copies the active profile's token into `out` (NUL-terminated) and returns
// true. Returns false when absent or too large for the buffer.
bool loadDeviceToken(char* out, size_t outSize);

// Persists `token` for the active profile; false on an NVS write failure.
bool saveDeviceToken(const char* token);

// Erases the active profile's token (no-op when absent).
void eraseDeviceToken();

}  // namespace bob
