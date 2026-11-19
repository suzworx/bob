// Bob Cardputer v2 — per-profile device tokens over KvStore (see include/device_token.h).
#include "device_token.h"

#include <cstring>

#include "types.h"

namespace bob {

const char* tokenKey(Profile profile) {
  switch (profile) {
    case Profile::kProd: return "tok_prod";
    case Profile::kDev: return "tok_dev";
    case Profile::kCustom: return "tok_cus";
  }
  return "tok_prod";
}

bool tokenHas(KvStore& kv, Profile profile) {
  return kv.bytesLength(kTokenNamespace, tokenKey(profile)) > 0;
}

bool tokenLoad(KvStore& kv, Profile profile, char* out, size_t outSize) {
  return kvGetString(kv, kTokenNamespace, tokenKey(profile), out, outSize);
}

bool tokenSave(KvStore& kv, Profile profile, const char* token) {
  if (!token) return false;
  const size_t len = strlen(token);
  if (len == 0 || len >= kDeviceTokenBytes) return false;
  return kv.putBytes(kTokenNamespace, tokenKey(profile), token, len);
}

bool tokenErase(KvStore& kv, Profile profile) {
  return kv.remove(kTokenNamespace, tokenKey(profile));
}

bool tokenEraseAll(KvStore& kv) { return kv.clear(kTokenNamespace); }

}  // namespace bob
