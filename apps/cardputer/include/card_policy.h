// Bob Cardputer v2 — the rules behind the READY cards and lists: scrolling
// the reply card, HELP and the pickers, and holding and deduplicating
// announcements (#319-#321). Pure, header-only and host-tested
// (test/host/test_card_policy.cpp); src/state_cards.cpp draws and plays.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>
#include "cards.h"
#include "types.h"

namespace bob {

// Moves *index one step (delta < 0 up, delta > 0 down) within 0..maxIndex.
// False when it is already at that end, so nothing needs a redraw.
inline bool stepWithin(size_t* index, size_t maxIndex, int delta) {
  if (delta < 0 && *index > 0) {
    --*index;
    return true;
  }
  if (delta > 0 && *index < maxIndex) {
    ++*index;
    return true;
  }
  return false;
}

// The last first-visible line of a card `lines` long (0 when it all fits).
inline size_t cardMaxFirstLine(size_t lines) {
  return lines > kCardVisibleLines ? lines - kCardVisibleLines : 0;
}

// Announcements that arrived while the device was busy (a small FIFO) and the
// ids acked most recently, so a server replay is never shown twice.
class AnnounceInbox {
 public:
  static constexpr size_t kDepth = 3;
  static constexpr size_t kRecentIds = 4;

  size_t held() const { return held_; }

  // True when `id` is waiting here or was acked recently.
  bool seen(const char* id) const {
    for (size_t i = 0; i < held_; ++i) {
      if (strcmp(queue_[i].id, id) == 0) return true;
    }
    for (size_t i = 0; i < kRecentIds; ++i) {
      if (strcmp(recent_[i], id) == 0) return true;
    }
    return false;
  }

  // False when the FIFO is full: the announcement is dropped unacked, and the
  // server replays it on the next connection.
  bool hold(const Announcement& announcement) {
    if (held_ == kDepth) return false;
    queue_[held_++] = announcement;
    return true;
  }

  // The oldest held announcement; false when none waits.
  bool takeNext(Announcement& out) {
    if (held_ == 0) return false;
    out = queue_[0];
    for (size_t i = 1; i < held_; ++i) queue_[i - 1] = queue_[i];
    --held_;
    return true;
  }

  // Remembers an acked id, replacing the oldest remembered one.
  void rememberAcked(const char* id) {
    strncpy(recent_[next_], id, kAnnounceIdBytes - 1);
    recent_[next_][kAnnounceIdBytes - 1] = '\0';
    next_ = (next_ + 1) % kRecentIds;
  }

  // The socket is gone: the held ones go (unacked, so the server replays
  // them); the acked ids stay remembered.
  void dropHeld() { held_ = 0; }

 private:
  Announcement queue_[kDepth];
  uint8_t held_ = 0;  // uint8_t: no padding next to the byte-aligned queue.
  char recent_[kRecentIds][kAnnounceIdBytes] = {};
  uint8_t next_ = 0;
};

}  // namespace bob
