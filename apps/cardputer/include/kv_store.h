// Bob Cardputer v2 — the key-value seam under every persisted setting (#675).
// Saved networks, the server profile, the per-profile device tokens and their
// migration are written against this interface, so the host tests run them on
// an in-memory fake; src/nvs_kv.cpp is the only Preferences (NVS) adapter.
// Namespace and key names are at most 15 characters (NVS limit).
#pragma once

#include <cstddef>
#include <cstdint>

namespace bob {

class KvStore {
 public:
  virtual ~KvStore() = default;
  virtual bool has(const char* ns, const char* key) = 0;
  // Returns false when absent.
  virtual bool getU8(const char* ns, const char* key, uint8_t* out) = 0;
  virtual bool putU8(const char* ns, const char* key, uint8_t value) = 0;
  virtual bool getU16(const char* ns, const char* key, uint16_t* out) = 0;
  virtual bool putU16(const char* ns, const char* key, uint16_t value) = 0;
  // Stored length in bytes; 0 when absent.
  virtual size_t bytesLength(const char* ns, const char* key) = 0;
  // Copies at most `cap` bytes; returns the number copied (0 when absent).
  virtual size_t getBytes(const char* ns, const char* key, void* out, size_t cap) = 0;
  virtual bool putBytes(const char* ns, const char* key, const void* data, size_t len) = 0;
  // Removing an absent key succeeds.
  virtual bool remove(const char* ns, const char* key) = 0;
  // Erases every key in the namespace.
  virtual bool clear(const char* ns) = 0;
};

// Reads a byte string into `out` as a NUL-terminated C string. False (and an
// empty `out`) when absent or when it does not fit in outSize - 1.
bool kvGetString(KvStore& kv, const char* ns, const char* key, char* out, size_t outSize);

// Stores `value` without its NUL. An empty value removes the key.
bool kvPutString(KvStore& kv, const char* ns, const char* key, const char* value);

}  // namespace bob
