// In-memory KvStore for the #675 settings host tests. Keys are typed the way
// NVS types them (u8, u16, blob): reading a key as the wrong type reads as
// absent, as a Preferences getter on a mismatched type would. `writeBudget`
// makes every write after the first N fail, to simulate a power cut.
#pragma once

#include <cstring>
#include <map>
#include <string>
#include <utility>
#include <vector>

#include "kv_store.h"

namespace hosttest {

class FakeKv final : public bob::KvStore {
 public:
  enum class Type { kU8, kU16, kBlob };
  struct Entry {
    Type type;
    std::vector<uint8_t> bytes;
  };
  using Key = std::pair<std::string, std::string>;

  std::map<Key, Entry> entries;
  int writeBudget = -1;  // -1 = unlimited
  int writes = 0;

  bool has(const char* ns, const char* key) override { return entries.count({ns, key}) > 0; }

  bool getU8(const char* ns, const char* key, uint8_t* out) override {
    const Entry* e = find(ns, key, Type::kU8);
    if (!e) return false;
    if (out) *out = e->bytes[0];
    return true;
  }
  bool putU8(const char* ns, const char* key, uint8_t value) override {
    return write(ns, key, {Type::kU8, {value}});
  }
  bool getU16(const char* ns, const char* key, uint16_t* out) override {
    const Entry* e = find(ns, key, Type::kU16);
    if (!e) return false;
    if (out) *out = static_cast<uint16_t>(e->bytes[0] | (e->bytes[1] << 8));
    return true;
  }
  bool putU16(const char* ns, const char* key, uint16_t value) override {
    return write(ns, key, {Type::kU16, {static_cast<uint8_t>(value & 0xff), static_cast<uint8_t>(value >> 8)}});
  }
  size_t bytesLength(const char* ns, const char* key) override {
    const Entry* e = find(ns, key, Type::kBlob);
    return e ? e->bytes.size() : 0;
  }
  size_t getBytes(const char* ns, const char* key, void* out, size_t cap) override {
    const Entry* e = find(ns, key, Type::kBlob);
    if (!e || e->bytes.size() > cap) return 0;
    memcpy(out, e->bytes.data(), e->bytes.size());
    return e->bytes.size();
  }
  bool putBytes(const char* ns, const char* key, const void* data, size_t len) override {
    const uint8_t* p = static_cast<const uint8_t*>(data);
    return write(ns, key, {Type::kBlob, std::vector<uint8_t>(p, p + len)});
  }
  bool remove(const char* ns, const char* key) override {
    if (!spend()) return false;
    entries.erase({ns, key});
    return true;
  }
  bool clear(const char* ns) override {
    if (!spend()) return false;
    for (auto it = entries.begin(); it != entries.end();) {
      it = it->first.first == ns ? entries.erase(it) : std::next(it);
    }
    return true;
  }

  // Test helpers.
  void putString(const char* ns, const char* key, const std::string& value) {
    putBytes(ns, key, value.data(), value.size());
  }
  std::string getString(const char* ns, const char* key) {
    const Entry* e = find(ns, key, Type::kBlob);
    return e ? std::string(e->bytes.begin(), e->bytes.end()) : std::string();
  }
  std::vector<std::string> keys(const char* ns) const {
    std::vector<std::string> out;
    for (const auto& [k, v] : entries) {
      if (k.first == ns) out.push_back(k.second);
    }
    return out;
  }

 private:
  const Entry* find(const char* ns, const char* key, Type type) const {
    const auto it = entries.find({ns, key});
    return it != entries.end() && it->second.type == type ? &it->second : nullptr;
  }
  bool spend() {
    if (writeBudget >= 0 && writes >= writeBudget) return false;
    ++writes;
    return true;
  }
  bool write(const char* ns, const char* key, Entry entry) {
    if (!spend()) return false;
    entries[{ns, key}] = std::move(entry);
    return true;
  }
};

}  // namespace hosttest
