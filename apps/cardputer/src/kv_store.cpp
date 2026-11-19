// Bob Cardputer v2 — string helpers over the KvStore seam (see include/kv_store.h).
#include "kv_store.h"

#include <cstring>

namespace bob {

bool kvGetString(KvStore& kv, const char* ns, const char* key, char* out, size_t outSize) {
  if (!out || outSize == 0) return false;
  out[0] = '\0';
  const size_t len = kv.bytesLength(ns, key);
  if (len == 0 || len >= outSize) return false;
  if (kv.getBytes(ns, key, out, len) != len) {
    out[0] = '\0';
    return false;
  }
  out[len] = '\0';
  return true;
}

bool kvPutString(KvStore& kv, const char* ns, const char* key, const char* value) {
  const size_t len = value ? strlen(value) : 0;
  if (len == 0) return kv.remove(ns, key);
  return kv.putBytes(ns, key, value, len);
}

}  // namespace bob
