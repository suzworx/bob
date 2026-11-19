// Bob — what went wrong with a spoken turn, in words a person can act on (pure logic, host-tested).
// The round touch board names the kind of failure under a confused Bob instead of one vague toast, and
// gives its error screens a plain caption (owner UX audit 2026-10-20, #1063). The Cardputer keeps its toast.
#pragma once

#include <stdint.h>
#include <string.h>

namespace bob {

enum class TurnTrouble : uint8_t {
  kNoInternet,  // the device lost its network while the turn was in flight
  kBusy,        // the server could not finish the turn (speech or AI stage failed: INTERNAL)
  kNotHeard,    // the audio never made it whole (BAD_AUDIO, SEQUENCE_GAP, ...), or nothing was said
  kOther,       // anything else: a generic, still kind, retry
};

// A server `error` code for the turn in flight. `online`: the Wi-Fi link is up.
inline TurnTrouble troubleForServerError(const char* code, bool online) {
  if (!online) return TurnTrouble::kNoInternet;
  if (code == nullptr) return TurnTrouble::kOther;
  if (strcmp(code, "INTERNAL") == 0) return TurnTrouble::kBusy;
  if (strcmp(code, "BAD_AUDIO") == 0 || strcmp(code, "SEQUENCE_GAP") == 0 || strcmp(code, "FRAME_TOO_LARGE") == 0 ||
      strcmp(code, "QUEUE_FULL") == 0) {
    return TurnTrouble::kNotHeard;
  }
  return TurnTrouble::kOther;
}

// One short line (it must fit the caption under Bob, ~150 px at the bottom of the circle).
inline const char* troubleCaption(TurnTrouble t) {
  switch (t) {
    case TurnTrouble::kNoInternet: return "No internet";
    case TurnTrouble::kBusy: return "Busy, try again";
    case TurnTrouble::kNotHeard: return "Didn't catch that";
    case TurnTrouble::kOther: return "Oops, try again";
  }
  return "Oops, try again";
}

// For the journal (no text, no codes beyond the wire's own).
inline const char* troubleName(TurnTrouble t) {
  switch (t) {
    case TurnTrouble::kNoInternet: return "no_internet";
    case TurnTrouble::kBusy: return "busy";
    case TurnTrouble::kNotHeard: return "not_heard";
    case TurnTrouble::kOther: return "other";
  }
  return "other";
}

// The error screen's plain caption for the state code's title ("MIC ERROR", "WS ERROR", "UPDATE NEEDED");
// nullptr keeps the title (sentence-cased by the round UI).
inline const char* plainErrorCaption(const char* title) {
  if (title == nullptr) return nullptr;
  if (strcmp(title, "MIC ERROR") == 0) return "Mic trouble";
  if (strcmp(title, "WS ERROR") == 0) return "Can't connect";
  if (strcmp(title, "UPDATE NEEDED") == 0) return "Update needed";
  return nullptr;
}

}  // namespace bob
