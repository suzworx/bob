// Bob Cardputer v2 — short generated tones for state changes (#322) and the
// announcement ring loop (#319/#320).
#pragma once

#include <cstdint>
#include "ring_policy.h"

namespace bob {

enum class Earcon : uint8_t {
  kListenStart,  // soft single ding: the mic is opening.
  kListenStop,   // rising pair: the mic closed, the turn was sent.
  kError,        // low single bell.
  kChime,        // reminder announcement.
  kDisconnect,   // a connection lost after welcome.
  kNotice,       // notice, distinct from reminder.
  kFollowupClose, // follow-up window ended without speech.
  kTimer,        // timer announcement without a repeating ring.
  kAlarm,        // alarm announcement without a repeating ring.
  kVolume,       // one short blip at the new level.
};

// Soft sine chimes with an attack/decay envelope, at the current volume.
// Silent while muted, at level 0, in DND, while the mic is open, or while
// another sound owns the speaker. Non-blocking; immutable PCM in flash outlives the speaker task.
void playEarcon(Earcon earcon);

// Blocks until the earcon channel is silent or maxMs passes. Used before the
// mic opens, because the mic and speaker share GPIO 43.
void waitForEarcon(uint32_t maxMs);

// True while an earcon is still sounding: a mic must not open yet (GPIO 43).
bool earconPlaying();
// Request channel retirement; immutable clip storage remains valid until drained.
void stopEarcon();

// Call after the mic closes: the mic took over the shared pin, so the next
// earcon re-installs the speaker driver first.
void markSpeakerPinsStale();
// Call right before capture.begin(): marks the pins stale and, on the Waveshare (one I2S port for
// speaker and mic), ends the speaker so the mic can take the port.
void releaseSpeakerForMic();

// (Re)installs the speaker driver: end() only when it is running, then
// begin(). M5Unified's Speaker.end() uninstalls the I2S port unconditionally,
// so ending a speaker that never began logs `E I2S: i2s_driver_uninstall
// ... has not installed` (HIL run 20260924-082431-3e28, first tone after boot).
void restartSpeaker();

// Idle rule (CP-QUIET): the class-D amp hisses whenever the speaker driver
// runs, so it is ended once nothing has played for kSpeakerIdleEndMs. The
// delay keeps it running across a ring pattern's gaps and quick volume
// blips. A held speaker (a reply is active), a playing channel, or a running
// mic (it owns the shared pin) resets the countdown. Pure: host-tested.
constexpr uint32_t kSpeakerIdleEndMs = 1000;
class SpeakerIdle {
 public:
  // True once: the caller should end the speaker now.
  bool tick(uint32_t nowMs, bool running, bool playing, bool held, bool micRunning) {
    if (!running || playing || held || micRunning) {
      armed_ = false;
      return false;
    }
    if (!armed_) {
      armed_ = true;
      idleSince_ = nowMs;
      return false;
    }
    if (nowMs - idleSince_ < kSpeakerIdleEndMs) return false;
    armed_ = false;
    return true;
  }

 private:
  bool armed_ = false;
  uint32_t idleSince_ = 0;
};

// AudioPlayback holds the speaker from reply start to teardown, so the idle
// rule never ends it between restartSpeaker() and the first playRaw().
void holdSpeaker(bool held);

// Call every loop: ends the speaker once it has been idle (see SpeakerIdle).
void speakerIdleTick(uint32_t nowMs);

// Ring loop for ring:true announcements (#389): `sound`'s pattern
// (ring_policy.h) repeats for `seconds`, then stops by itself and ringTick()
// returns true once. ringStop() ends it early (a key or GO). The notes play at
// the current volume like every earcon.
//
// Mute rule: the ring follows the speaker. Muted (or at volume 0) it is
// silent, but the card still shows "Ringing", still stops after `seconds` and
// still acks "missed" — the mute never shortens or skips the timer.
void ringStart(uint32_t nowMs, RingSound sound, uint8_t seconds, bool alarm = false);
void ringStop();
bool ringing();
bool ringTick(uint32_t nowMs);
// How long the current (or just stopped) ring has sounded, for ring_stopped.
uint32_t ringElapsedMs(uint32_t nowMs);

}  // namespace bob
