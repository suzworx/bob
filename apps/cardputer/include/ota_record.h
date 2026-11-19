// Bob Cardputer v2 — what the device remembers about an update across the
// reboot into it (epic #343): the pending record, and the last_ota outcome the
// next hello reports. Pure, header-only, host-tested (test/host/test_ota_record.cpp).
#pragma once

#include <cstdio>
#include <cstring>

#include "kv_store.h"

namespace bob {

constexpr char kOtaNamespace[] = "bob_ota";
constexpr char kOtaKeyFrom[] = "p_from";
constexpr char kOtaKeyTo[] = "p_to";
constexpr char kOtaKeyResult[] = "l_res";
constexpr char kOtaKeyLastTo[] = "l_to";
constexpr char kOtaKeyReason[] = "l_why";

constexpr size_t kOtaVersionBytes = 33;
constexpr size_t kOtaReasonBytes = 25;

struct OtaLast {
  char result[12] = "";  // ok | rolled_back | failed; empty = nothing to report.
  char to[kOtaVersionBytes] = "";
  char reason[kOtaReasonBytes] = "";
};

// Written just before the reboot into the new image.
inline void otaWritePending(KvStore& kv, const char* from, const char* to) {
  kvPutString(kv, kOtaNamespace, kOtaKeyFrom, from);
  kvPutString(kv, kOtaNamespace, kOtaKeyTo, to);
}

// A failed attempt that never left the running image (download, verify, flash).
inline void otaWriteFailed(KvStore& kv, const char* to, const char* reason) {
  kvPutString(kv, kOtaNamespace, kOtaKeyResult, "failed");
  kvPutString(kv, kOtaNamespace, kOtaKeyLastTo, to);
  kvPutString(kv, kOtaNamespace, kOtaKeyReason, reason);
}

inline bool otaReadLast(KvStore& kv, OtaLast* out) {
  *out = OtaLast();
  if (!kvGetString(kv, kOtaNamespace, kOtaKeyResult, out->result, sizeof(out->result))) return false;
  kvGetString(kv, kOtaNamespace, kOtaKeyLastTo, out->to, sizeof(out->to));
  kvGetString(kv, kOtaNamespace, kOtaKeyReason, out->reason, sizeof(out->reason));
  return out->to[0] != '\0';
}

// The server has the outcome (a welcome followed the hello that carried it), so it is not reported again.
inline void otaClearLast(KvStore& kv) {
  kv.remove(kOtaNamespace, kOtaKeyResult);
  kv.remove(kOtaNamespace, kOtaKeyLastTo);
  kv.remove(kOtaNamespace, kOtaKeyReason);
}

// Run once per boot, before the first hello. A pending record settles into the
// last-outcome record: running the target is ok, running the old version is a
// rollback, anything else (a USB flash in between) says nothing. The pending
// record is cleared, except while the target image still awaits its health
// gate (unconfirmed): then it stays, so a crash before the gate is a rollback
// and not an ok. The gate calls this again with unconfirmed=false.
inline void otaSettleBoot(KvStore& kv, const char* running, bool unconfirmed = false) {
  char from[kOtaVersionBytes] = "";
  char to[kOtaVersionBytes] = "";
  const bool pending = kvGetString(kv, kOtaNamespace, kOtaKeyFrom, from, sizeof(from)) &&
                       kvGetString(kv, kOtaNamespace, kOtaKeyTo, to, sizeof(to));
  if (pending && unconfirmed && strcmp(running, to) == 0) return;
  kv.remove(kOtaNamespace, kOtaKeyFrom);
  kv.remove(kOtaNamespace, kOtaKeyTo);
  if (!pending) return;
  if (strcmp(running, to) == 0) {
    kvPutString(kv, kOtaNamespace, kOtaKeyResult, "ok");
    kvPutString(kv, kOtaNamespace, kOtaKeyReason, "");
  } else if (strcmp(running, from) == 0) {
    kvPutString(kv, kOtaNamespace, kOtaKeyResult, "rolled_back");
    kvPutString(kv, kOtaNamespace, kOtaKeyReason, "boot_failed");
  } else {
    return;
  }
  kvPutString(kv, kOtaNamespace, kOtaKeyLastTo, to);
}

}  // namespace bob
