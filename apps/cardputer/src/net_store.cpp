// Bob Cardputer v2 — saved Wi-Fi networks (see include/net_store.h).
#include "net_store.h"

#include <cstdio>
#include <cstring>
#include <initializer_list>

namespace bob {

namespace {

constexpr char kOrderKey[] = "order";
constexpr char kSchemaKey[] = "schema";

// "s<i>_<field>", e.g. "s3_ssid".
void slotKey(char (&out)[12], uint8_t slot, const char* field) {
  snprintf(out, sizeof(out), "s%u_%s", static_cast<unsigned>(slot), field);
}

void copyField(char* dst, size_t cap, const char* src) {
  strncpy(dst, src, cap - 1);
  dst[cap - 1] = '\0';
}

bool validSlot(const NetworkList& list, uint8_t slot) {
  return slot < kMaxNetworks && list.slot[slot].used;
}

void fill(SavedNetwork& net, const char* ssid, const char* pass, uint8_t flags) {
  net.used = true;
  copyField(net.ssid, sizeof(net.ssid), ssid);
  copyField(net.pass, sizeof(net.pass), pass);
  net.flags = static_cast<uint8_t>(pass[0] == '\0' ? (flags | kNetFlagOpen) : (flags & ~kNetFlagOpen));
  net.last = JoinResult::kNever;
}

NetError checkCredentials(const char* ssid, const char* pass) {
  if (!ssidValid(ssid)) return NetError::kInvalidSsid;
  if (!passValid(pass)) return NetError::kInvalidPass;
  return NetError::kOk;
}

}  // namespace

void netClear(NetworkList& list) {
  memset(&list, 0, sizeof(list));
  memset(list.order, kNoSlot, sizeof(list.order));
}

uint8_t netFind(const NetworkList& list, const char* ssid) {
  if (!ssid) return kNoSlot;
  for (uint8_t i = 0; i < kMaxNetworks; ++i) {
    if (list.slot[i].used && strcmp(list.slot[i].ssid, ssid) == 0) return i;
  }
  return kNoSlot;
}

uint8_t netRank(const NetworkList& list, uint8_t slot) {
  for (uint8_t r = 0; r < list.count; ++r) {
    if (list.order[r] == slot) return r;
  }
  return kNoSlot;
}

NetError netAdd(NetworkList& list, const char* ssid, const char* pass, uint8_t flags,
                uint8_t* outSlot) {
  const NetError bad = checkCredentials(ssid, pass);
  if (bad != NetError::kOk) return bad;
  const uint8_t existing = netFind(list, ssid);
  if (existing != kNoSlot) {
    fill(list.slot[existing], ssid, pass, flags);
    if (outSlot) *outSlot = existing;
    return NetError::kOk;
  }
  if (list.count >= kMaxNetworks) return NetError::kFull;
  uint8_t free = kNoSlot;
  for (uint8_t i = 0; i < kMaxNetworks && free == kNoSlot; ++i) {
    if (!list.slot[i].used) free = i;
  }
  fill(list.slot[free], ssid, pass, flags);
  list.order[list.count++] = free;
  if (outSlot) *outSlot = free;
  return NetError::kOk;
}

NetError netUpdate(NetworkList& list, uint8_t slot, const char* ssid, const char* pass) {
  if (!validSlot(list, slot)) return NetError::kNotFound;
  SavedNetwork& net = list.slot[slot];
  const NetError bad = checkCredentials(ssid ? ssid : net.ssid, pass ? pass : net.pass);
  if (bad != NetError::kOk) return bad;
  if (ssid) {
    const uint8_t clash = netFind(list, ssid);
    if (clash != kNoSlot && clash != slot) netRemove(list, clash);
    copyField(net.ssid, sizeof(net.ssid), ssid);
  }
  if (pass) {
    copyField(net.pass, sizeof(net.pass), pass);
    net.flags = static_cast<uint8_t>(pass[0] == '\0' ? (net.flags | kNetFlagOpen)
                                                     : (net.flags & ~kNetFlagOpen));
  }
  net.last = JoinResult::kNever;
  return NetError::kOk;
}

NetError netRemove(NetworkList& list, uint8_t slot) {
  const uint8_t rank = netRank(list, slot);
  if (!validSlot(list, slot) || rank == kNoSlot) return NetError::kNotFound;
  memset(&list.slot[slot], 0, sizeof(list.slot[slot]));
  for (uint8_t r = rank; r + 1 < list.count; ++r) list.order[r] = list.order[r + 1];
  list.order[--list.count] = kNoSlot;
  return NetError::kOk;
}

NetError netReplace(NetworkList& list, uint8_t victim, const char* ssid, const char* pass,
                    uint8_t flags) {
  if (!validSlot(list, victim)) return NetError::kNotFound;
  const NetError bad = checkCredentials(ssid, pass);
  if (bad != NetError::kOk) return bad;
  const uint8_t clash = netFind(list, ssid);
  if (clash != kNoSlot && clash != victim) netRemove(list, clash);
  fill(list.slot[victim], ssid, pass, flags);
  return NetError::kOk;
}

NetError netCommitJoined(NetworkList& list, const char* ssid, const char* pass, uint8_t flags,
                         uint8_t victim, uint8_t* outSlot, uint8_t* outOldRank) {
  uint8_t slot = victim;
  const NetError error = victim == kNoSlot ? netAdd(list, ssid, pass, flags, &slot)
                                           : netReplace(list, victim, ssid, pass, flags);
  if (error != NetError::kOk) return error;
  const uint8_t oldRank = netRank(list, slot);
  netMove(list, slot, -static_cast<int>(kMaxNetworks));
  list.slot[slot].last = JoinResult::kOk;
  if (outSlot) *outSlot = slot;
  if (outOldRank) *outOldRank = oldRank;
  return NetError::kOk;
}

NetError netMove(NetworkList& list, uint8_t slot, int delta) {
  const uint8_t rank = netRank(list, slot);
  if (!validSlot(list, slot) || rank == kNoSlot) return NetError::kNotFound;
  int target = static_cast<int>(rank) + delta;
  if (target < 0) target = 0;
  if (target > list.count - 1) target = list.count - 1;
  uint8_t r = rank;
  while (r < target) {
    list.order[r] = list.order[r + 1];
    ++r;
  }
  while (r > target) {
    list.order[r] = list.order[r - 1];
    --r;
  }
  list.order[target] = slot;
  return NetError::kOk;
}

void netLoad(KvStore& kv, NetworkList& list) {
  netClear(list);
  uint8_t order[kMaxNetworks];
  memset(order, kNoSlot, sizeof(order));
  kv.getBytes(kNetNamespace, kOrderKey, order, sizeof(order));
  char key[12];
  for (uint8_t r = 0; r < kMaxNetworks; ++r) {
    const uint8_t slot = order[r];
    if (slot >= kMaxNetworks || list.slot[slot].used) continue;  // pad or duplicate
    SavedNetwork& net = list.slot[slot];
    slotKey(key, slot, "ssid");
    if (!kvGetString(kv, kNetNamespace, key, net.ssid, sizeof(net.ssid))) continue;
    slotKey(key, slot, "pass");
    if (kv.bytesLength(kNetNamespace, key) > 0 &&
        !kvGetString(kv, kNetNamespace, key, net.pass, sizeof(net.pass))) {
      continue;
    }
    if (!ssidValid(net.ssid) || !passValid(net.pass)) {
      memset(&net, 0, sizeof(net));
      continue;
    }
    slotKey(key, slot, "flags");
    kv.getU8(kNetNamespace, key, &net.flags);
    uint8_t last = 0;
    slotKey(key, slot, "last");
    kv.getU8(kNetNamespace, key, &last);
    net.last = last <= static_cast<uint8_t>(JoinResult::kNoInternet) ? static_cast<JoinResult>(last)
                                                                      : JoinResult::kNever;
    net.used = true;
    list.order[list.count++] = slot;
  }
}

bool netSave(KvStore& kv, const NetworkList& list) {
  bool ok = true;
  char key[12];
  for (uint8_t i = 0; i < kMaxNetworks; ++i) {
    const SavedNetwork& net = list.slot[i];
    if (net.used) {
      slotKey(key, i, "ssid");
      ok = kvPutString(kv, kNetNamespace, key, net.ssid) && ok;
      slotKey(key, i, "pass");
      ok = kvPutString(kv, kNetNamespace, key, net.pass) && ok;
      slotKey(key, i, "flags");
      ok = kv.putU8(kNetNamespace, key, net.flags) && ok;
      slotKey(key, i, "last");
      ok = kv.putU8(kNetNamespace, key, static_cast<uint8_t>(net.last)) && ok;
    } else {
      for (const char* field : {"ssid", "pass", "flags", "last"}) {
        slotKey(key, i, field);
        ok = kv.remove(kNetNamespace, key) && ok;
      }
    }
  }
  // The order goes last: a torn save leaves at worst an unreferenced slot.
  return kv.putBytes(kNetNamespace, kOrderKey, list.order, sizeof(list.order)) && ok;
}

bool netEraseAll(KvStore& kv) {
  // Keep the schema so a forgotten seed network is not re-seeded at boot.
  const bool cleared = kv.clear(kNetNamespace);
  return kv.putU8(kNetNamespace, kSchemaKey, kNetSchema) && cleared;
}

}  // namespace bob
