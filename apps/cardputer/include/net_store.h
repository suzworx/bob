// Bob Cardputer v2 — saved Wi-Fi networks (#675; pure over KvStore, host-tested).
// Up to five networks in NVS namespace "bob_net", tried in priority order.
// Each network keeps a stable slot id for its lifetime; the slot id is the only
// thing a journal line may name (never the SSID or password). A NetworkList is
// ~0.5 KB: allocate it on the heap while needed, never as a static.
#pragma once

#include <cstddef>
#include <cstdint>

#include "kv_store.h"
#include "settings_rules.h"

namespace bob {

constexpr uint8_t kMaxNetworks = 5;
constexpr uint8_t kNoSlot = 0xFF;
constexpr char kNetNamespace[] = "bob_net";
constexpr uint8_t kNetSchema = 1;

// SavedNetwork::flags bits.
constexpr uint8_t kNetFlagHidden = 1 << 0;  // try even when a scan does not show it
constexpr uint8_t kNetFlagOpen = 1 << 1;    // no password
constexpr uint8_t kNetFlagSeeded = 1 << 2;  // copied from secrets.h on first boot

// Result of the last join attempt, persisted per slot. Append, never renumber.
enum class JoinResult : uint8_t {
  kNever = 0,
  kOk = 1,
  kAuth = 2,
  kNoAp = 3,
  kTimeout = 4,
  kCaptive = 5,
  kNoInternet = 6,
};

struct SavedNetwork {
  bool used;
  char ssid[kSsidMaxBytes + 1];
  char pass[kPassMaxBytes + 1];
  uint8_t flags;
  JoinResult last;
};

struct NetworkList {
  SavedNetwork slot[kMaxNetworks];
  uint8_t order[kMaxNetworks];  // slot ids, highest priority first; kNoSlot pads
  uint8_t count;
};

enum class NetError : uint8_t { kOk, kFull, kInvalidSsid, kInvalidPass, kNotFound };

void netClear(NetworkList& list);

// Adds a network at the lowest priority. A network with the same SSID is
// updated in place instead (keeping its slot and priority). outSlot may be null.
NetError netAdd(NetworkList& list, const char* ssid, const char* pass, uint8_t flags,
                uint8_t* outSlot);

// Changes a saved network's SSID and/or password; null leaves a field as is.
NetError netUpdate(NetworkList& list, uint8_t slot, const char* ssid, const char* pass);

NetError netRemove(NetworkList& list, uint8_t slot);

// Forgets `victim` and stores the new network in its slot, at its priority.
NetError netReplace(NetworkList& list, uint8_t victim, const char* ssid, const char* pass,
                    uint8_t flags);

// Moves a network `delta` places in priority (negative = earlier). Clamped.
NetError netMove(NetworkList& list, uint8_t slot, int delta);

// Verify-then-commit for a network the device just joined (#677). Saves it at
// the lowest priority (in place when its SSID is saved already) or, when
// `victim` is a saved slot, forgets the victim and stores it in that slot;
// then moves it first in line and marks its last join ok. kFull when all five
// are saved, the SSID is new and no victim was named: the caller asks which
// one to replace. outSlot and outOldRank (its rank before moving first, for
// "keep old order") may be null. Nothing changes on an error.
NetError netCommitJoined(NetworkList& list, const char* ssid, const char* pass, uint8_t flags,
                         uint8_t victim, uint8_t* outSlot, uint8_t* outOldRank);

// Rows of the Settings Wi-Fi list (S10): the saved networks in priority order,
// then "+ Add network". The add row stays when all five are saved, because a
// sixth network asks which one to replace (#677).
inline size_t netListRows(const NetworkList& list) { return list.count + 1u; }

// Slot id holding `ssid`, or kNoSlot.
uint8_t netFind(const NetworkList& list, const char* ssid);

// Priority rank (0 = first) of `slot`, or kNoSlot.
uint8_t netRank(const NetworkList& list, uint8_t slot);

// NVS. netLoad clears `list` first and skips any slot that fails validation
// (a corrupt entry is dropped, never joined). netSave writes every used slot
// and removes the keys of unused ones.
void netLoad(KvStore& kv, NetworkList& list);
bool netSave(KvStore& kv, const NetworkList& list);
bool netEraseAll(KvStore& kv);

}  // namespace bob
