// Bob Cardputer v2 — the follow-up window (pure logic, no I/O).
//
// Alexa's "follow-up mode": after a reply finishes playing in Always awake the
// mic stays open for kFollowUpWindowMs. Speech (the VAD's onset) inside the
// window opens a turn without the wake word; silence until the deadline closes
// the window and wake listening resumes. The caller owns the mic, the VAD and
// the pre-roll frames; this decides only when the window ends and why.
#pragma once

#include <cstddef>
#include <cstdint>
#include "types.h"

namespace bob {

constexpr uint32_t kFollowUpWindowMs = 6000;
// Frames kept from before the speech onset so the first syllable is sent too.
constexpr uint32_t kFollowUpPreRollMs = 300;
constexpr size_t kFollowUpPreRollFrames = kFollowUpPreRollMs / 10;
// Speech that opens a turn in the window: 200 ms (20 frames), not the wake
// turn's 50 ms, so the reply's tail or echo, a cough or a key click does not.
constexpr uint32_t kFollowUpOnsetMs = 200;
// The window opens this long after the speaker has actually drained (the
// reply's playback_completed), so the mic never hears the reply's last word.
constexpr uint32_t kFollowUpGuardMs = 250;

// Speech already under way when the deadline passes gets this long more to
// reach its onset (kFollowUpOnsetMs), so the window never cuts a sentence's
// first word in half.
constexpr uint32_t kFollowUpOnsetGraceMs = 300;
// Follow-up turns one wake (or GO) turn may lead to. Without a cap a TV or a
// radio keeps answering the device's own questions forever (review 2026-09-24).
constexpr uint8_t kMaxFollowUpsPerWake = 2;

// True once kFollowUpGuardMs have passed since `drainedAtMs` (millis-wrap safe).
inline bool followUpGuardPassed(uint32_t drainedAtMs, uint32_t nowMs) {
  return nowMs - drainedAtMs >= kFollowUpGuardMs;
}

// Why a window closed; the journal's followup_closed reason=.
enum class FollowUpClose : uint8_t {
  kSpeech,      // a turn opened.
  kTimeout,     // no speech before the deadline.
  kKey,         // a key or GO.
  kAnnounce,    // an announcement or ring took over.
  kStop,        // x.
  kMode,        // the mode or DND changed, or the device left READY otherwise.
  kDisconnect,  // the socket closed.
  kMic,         // the mic did not open or failed.
};

inline const char* followUpCloseName(FollowUpClose reason) {
  switch (reason) {
    case FollowUpClose::kSpeech: return "speech";
    case FollowUpClose::kTimeout: return "timeout";
    case FollowUpClose::kKey: return "key";
    case FollowUpClose::kAnnounce: return "announce";
    case FollowUpClose::kStop: return "stop";
    case FollowUpClose::kMode: return "mode";
    case FollowUpClose::kDisconnect: return "disconnect";
    case FollowUpClose::kMic: return "mic";
  }
  return "unknown";
}

// A reply that finished playing opens the window only in Always awake that is
// really listening (not fallen back to push-to-talk) and without DND.
inline bool followUpAfterReply(DeviceMode mode, bool wakeFailed, bool dnd) {
  return mode == DeviceMode::kWake && !wakeFailed && !dnd;
}

enum class FollowUpDecision : uint8_t { kNone, kSpeech, kTimeout };

class FollowUpWindow {
 public:
  void open(uint32_t nowMs, uint32_t windowMs = kFollowUpWindowMs) {
    openedAtMs_ = nowMs;
    windowMs_ = windowMs;
    open_ = true;
  }

  void close() { open_ = false; }
  bool isOpen() const { return open_; }
  uint32_t windowMs() const { return windowMs_; }

  // What this loop's frames mean for an open window. Speech wins over a
  // deadline reached on the same tick: the user was already talking. A voiced
  // run still short of the onset (`voicedRun`) keeps the window up to
  // kFollowUpOnsetGraceMs past the deadline. Elapsed time is an unsigned
  // difference, so it survives the millis() wrap.
  FollowUpDecision decide(uint32_t nowMs, bool speech, bool voicedRun = false) const {
    if (!open_) return FollowUpDecision::kNone;
    if (speech) return FollowUpDecision::kSpeech;
    const uint32_t elapsed = nowMs - openedAtMs_;
    if (elapsed < windowMs_) return FollowUpDecision::kNone;
    if (voicedRun && elapsed < windowMs_ + kFollowUpOnsetGraceMs) return FollowUpDecision::kNone;
    return FollowUpDecision::kTimeout;
  }

 private:
  uint32_t openedAtMs_ = 0;
  uint32_t windowMs_ = kFollowUpWindowMs;
  bool open_ = false;
};

// One wake's conversation: the wake (or GO) turn and the follow-up turns
// after it. A window opens after a reply only while the chain allows it: at
// most kMaxFollowUpsPerWake follow-ups, and none after any turn the server
// heard as nothing (reply_text heard_len=0) or a turn that failed.
class FollowUpChain {
 public:
  void beginChain() {
    followUps_ = 0;
    ended_ = false;
  }
  void followUpTurn() {
    if (followUps_ < 255) ++followUps_;
  }
  void end() { ended_ = true; }
  // A reply heard as nothing ends the chain on ANY turn, wake or follow-up: a
  // TTS-stage 402 out-of-credit reply (heard="") must never open a window (#1041).
  void replyHeard(const char* heard) {
    if (heard == nullptr || heard[0] == '\0') end();
  }
  bool allowsWindow() const { return !ended_ && followUps_ < kMaxFollowUpsPerWake; }
  uint8_t followUps() const { return followUps_; }

 private:
  uint8_t followUps_ = 0;
  bool ended_ = false;
};

}  // namespace bob
