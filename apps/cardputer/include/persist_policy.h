// Bob Cardputer v2 — when changed settings may be written to NVS (pure;
// host-tested in test/host/test_persist_policy.cpp).
#pragma once

#include <cstdint>

namespace bob {

// True when a commit is due: something changed, it has been quiet for
// `quietMs` since the last change, and (after the first commit) `minIntervalMs`
// have passed since the previous commit. The differences are compared signed,
// like deviceStateDue(): the caller passes the loop's start time, and a change
// stamped with millis() later in the same iteration makes `nowMs - lastChangeAt`
// negative, which an unsigned compare would read as ~49 days of quiet.
inline bool persistDue(bool dirty, uint32_t nowMs, uint32_t lastChangeAt, bool committed,
                       uint32_t lastCommitAt, uint32_t quietMs, uint32_t minIntervalMs) {
  if (!dirty) return false;
  if (static_cast<int32_t>(nowMs - lastChangeAt) < static_cast<int32_t>(quietMs)) return false;
  if (committed && static_cast<int32_t>(nowMs - lastCommitAt) < static_cast<int32_t>(minIntervalMs)) {
    return false;
  }
  return true;
}

}  // namespace bob
