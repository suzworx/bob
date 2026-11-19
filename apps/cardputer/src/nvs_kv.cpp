// Bob Cardputer v2 — the device's KvStore: Preferences (NVS) (#675).
// Each call opens and closes its namespace, as settings.cpp and the token
// store always have; these are rare, user-driven writes. Every open is
// read-write, reads included: a read-only open of a namespace that does not
// exist yet (every first boot) fails with an `nvs_open failed` error line on
// serial, and every serial line is a journal line (HIL cleanSerial). A
// read-write open creates the namespace instead (settings.cpp does the same).
#include <Preferences.h>

#include "device_settings.h"

namespace bob {

namespace {

class NvsKv final : public KvStore {
 public:
  bool has(const char* ns, const char* key) override {
    Preferences prefs;
    if (!prefs.begin(ns, false)) return false;
    const bool present = prefs.isKey(key);
    prefs.end();
    return present;
  }

  bool getU8(const char* ns, const char* key, uint8_t* out) override {
    Preferences prefs;
    if (!prefs.begin(ns, false)) return false;
    const bool present = prefs.isKey(key);
    if (present && out) *out = prefs.getUChar(key, 0);
    prefs.end();
    return present;
  }

  bool putU8(const char* ns, const char* key, uint8_t value) override {
    Preferences prefs;
    if (!prefs.begin(ns, false)) return false;
    const bool ok = prefs.putUChar(key, value) == sizeof(value);
    prefs.end();
    return ok;
  }

  bool getU16(const char* ns, const char* key, uint16_t* out) override {
    Preferences prefs;
    if (!prefs.begin(ns, false)) return false;
    const bool present = prefs.isKey(key);
    if (present && out) *out = prefs.getUShort(key, 0);
    prefs.end();
    return present;
  }

  bool putU16(const char* ns, const char* key, uint16_t value) override {
    Preferences prefs;
    if (!prefs.begin(ns, false)) return false;
    const bool ok = prefs.putUShort(key, value) == sizeof(value);
    prefs.end();
    return ok;
  }

  size_t bytesLength(const char* ns, const char* key) override {
    Preferences prefs;
    if (!prefs.begin(ns, false)) return 0;
    const size_t len = prefs.isKey(key) ? prefs.getBytesLength(key) : 0;
    prefs.end();
    return len;
  }

  size_t getBytes(const char* ns, const char* key, void* out, size_t cap) override {
    Preferences prefs;
    if (!prefs.begin(ns, false)) return 0;
    size_t copied = 0;
    if (prefs.isKey(key)) {
      const size_t len = prefs.getBytesLength(key);
      if (len > 0 && len <= cap) copied = prefs.getBytes(key, out, len);
    }
    prefs.end();
    return copied;
  }

  bool putBytes(const char* ns, const char* key, const void* data, size_t len) override {
    Preferences prefs;
    if (!prefs.begin(ns, false)) return false;
    const bool ok = prefs.putBytes(key, data, len) == len;
    prefs.end();
    return ok;
  }

  bool remove(const char* ns, const char* key) override {
    Preferences prefs;
    if (!prefs.begin(ns, false)) return false;
    if (prefs.isKey(key)) prefs.remove(key);
    prefs.end();
    return true;
  }

  bool clear(const char* ns) override {
    Preferences prefs;
    if (!prefs.begin(ns, false)) return false;
    const bool ok = prefs.clear();
    prefs.end();
    return ok;
  }
};

}  // namespace

KvStore& deviceStore() {
  static NvsKv store;
  return store;
}

}  // namespace bob
