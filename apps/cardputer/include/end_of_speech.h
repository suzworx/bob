// Bob Cardputer v2 — end of speech for hands-free turns (pure logic, no I/O).
//
// A wake or follow-up turn has no button to let go of: it ends when the
// speaker stops. Each 10 ms frame's energy (dB re one LSB) is compared with
// the adaptive noise floor the caller keeps. A speech run starts on a frame
// over an absolute minimum and kVadSpeechOverFloorDb over the floor, and
// continues while frames stay kVadSpeechHoldOverFloorDb over it (hysteresis).
// The onset length of it (dips under kVadWordGapMs between syllables bridged)
// is "talking": kVadOnsetMs by default. Follow-up confirmation instead needs
// onset-level frames with gaps shorter than 50 ms. The turn then ends
// after kVadEndSilenceMs with no speech frame, never sooner than
// kVadMinSpeechWindowMs after the onset, and at kVadMaxTurnMs in any case.
//
// Tuned from the owner's turns (2026-09-24, #392): speech peaks ~54 dB over a
// ~16 dB floor, sentences carry pauses of up to ~900 ms, and the old 700 ms
// silence rule cut them off ~2.5 s in. The Waveshare (tap-to-talk and wake
// turns, owner UX audit 2026-10-20, #1063) keeps 1000 ms of silence: 600 ms
// was tried in PR 2 and cut long sentences (HIL turn-long-sentence: pauses
// ~0.9-1.0 s), and 400 ms cut off kids and the owner. A semantic end of turn
// (#1365) is what goes lower. Still never before kVadMinSpeechWindowMs after
// the onset, so a pause early in a sentence is bridged; a pause over 1000 ms
// later ends the turn. Push-to-talk never ends on the VAD.
#pragma once

#include <cstdint>

namespace bob {

constexpr uint32_t kVadFrameMs = 10;
constexpr float kVadMinSpeechDb = 38.0f;        // a quiet speaker at arm's length.
constexpr float kVadSpeechOverFloorDb = 12.0f;     // a run starts this far over the floor...
constexpr float kVadSpeechHoldOverFloorDb = 8.0f;  // ...and holds while frames stay this far over.
constexpr uint32_t kVadOnsetMs = 50;           // wake turns; the follow-up window asks more (follow_up.h).
constexpr uint32_t kVadWordGapMs = 150;         // a shorter dip is inside a word.
constexpr uint32_t kVadEndSilenceMs = 1200;
constexpr uint32_t kVadQuickEndSilenceMs = 1000;  // the round touch board's hands-free turns.
#if defined(BOB_BOARD_WAVESHARE_185C)
constexpr uint32_t kVadHandsFreeEndSilenceMs = kVadQuickEndSilenceMs;
#else
constexpr uint32_t kVadHandsFreeEndSilenceMs = kVadEndSilenceMs;
#endif
constexpr uint32_t kVadMinSpeechWindowMs = 1500;
constexpr uint32_t kVadMaxTurnMs = 15000;       // 1500 frames x 340 B: well under the 1 MB uplink bound.
constexpr uint32_t kVadNoSpeechMs = 8000;       // woken, then nothing said.

// floorDb < 0: the floor is not measured yet, so only the minimum applies.
inline bool isSpeechFrame(float db, float floorDb) {
  return db > kVadMinSpeechDb && (floorDb < 0.0f || db > floorDb + kVadSpeechOverFloorDb);
}

// Hysteresis: once a run is going, a frame continues it down to floor + 8 dB
// (the absolute minimum only applies before the floor is measured).
inline bool isSpeechHoldFrame(float db, float floorDb) {
  return floorDb < 0.0f ? db > kVadMinSpeechDb : db > floorDb + kVadSpeechHoldOverFloorDb;
}

enum class VadOnset : uint8_t { kWake, kFollowUp };
constexpr uint32_t kVadFollowUpGapMs = 50;  // reject separated clicks before confirmation.

enum class VadEnd : uint8_t { kNone, kSilence, kMax };

inline const char* vadEndName(VadEnd end) {
  switch (end) {
    case VadEnd::kNone: return "none";
    case VadEnd::kSilence: return "silence";
    case VadEnd::kMax: return "max";
  }
  return "none";
}

// The server's end_of_turn (#1365) closes a hands-free capture early, ahead of the
// kVadHandsFreeEndSilenceMs fallback. It must name the turn in capture; a stale or unknown
// ref, a message after capture already ended, and a push-to-talk hold (GO ends it) are no-ops.
inline bool serverEndOfTurnCloses(bool capturing, bool handsFree, const char* activeRef, const char* msgRef) {
  if (!capturing || !handsFree) return false;
  if (activeRef == nullptr || msgRef == nullptr || msgRef[0] == '\0') return false;
  for (; *activeRef != '\0' && *activeRef == *msgRef; ++activeRef, ++msgRef) {}
  return *activeRef == '\0' && *msgRef == '\0';
}

class EndOfSpeech {
 public:
  // onsetMs: how much speech (gaps under kVadWordGapMs bridged) counts as
  // talking: kVadOnsetMs for a wake turn, kFollowUpOnsetMs in the window.
  // Follow-up confirmation counts only onset-level frames and bridges <50 ms;
  // after confirmation the existing hold threshold and pause timing apply.
  // endSilenceMs: the silence after the last word that ends the turn.
  void reset(uint32_t onsetMs = kVadOnsetMs, VadOnset policy = VadOnset::kWake,
             uint32_t endSilenceMs = kVadEndSilenceMs) {
    *this = EndOfSpeech();
    onsetNeedMs_ = onsetMs;
    onsetPolicy_ = policy;
    endSilenceMs_ = endSilenceMs;
  }

  // One frame. Returns true while the speaker is voiced (a speech frame, or a
  // dip inside the active onset/word gap): the caller moves the noise floor only on
  // frames that return false. No-op once ended.
  bool feed(float db, float floorDb, uint32_t frameMs = kVadFrameMs) {
    if (ended_ != VadEnd::kNone) return false;
    turnMs_ += frameMs;
    const bool confirmingFollowUp = onsetPolicy_ == VadOnset::kFollowUp && !heard_;
    const bool speech = inRun_ && !confirmingFollowUp ? isSpeechHoldFrame(db, floorDb) : isSpeechFrame(db, floorDb);
    inRun_ = speech;
    if (speech) {
      if (runMs_ == 0) runStartMs_ = turnMs_ - frameMs;
      runMs_ += frameMs;
      gapMs_ = 0;
      if (!heard_ && runMs_ >= onsetNeedMs_) {
        heard_ = true;
        onsetMs_ = runStartMs_;
      }
      lastSpeechEndMs_ = turnMs_;
    } else {
      gapMs_ += frameMs;
      const uint32_t gapLimit = confirmingFollowUp ? kVadFollowUpGapMs : kVadWordGapMs;
      if (gapMs_ >= gapLimit) runMs_ = 0;
    }
    if (heard_ && gapMs_ >= endSilenceMs_ && turnMs_ - onsetMs_ >= kVadMinSpeechWindowMs) {
      ended_ = VadEnd::kSilence;
    } else if (turnMs_ >= kVadMaxTurnMs || (!heard_ && turnMs_ >= kVadNoSpeechMs)) {
      ended_ = VadEnd::kMax;
    }
    return speech || runMs_ > 0;
  }

  bool heardSpeech() const { return heard_; }
  // A speech run is under way within the active gap limit: the follow-up
  // window gives it time to reach the onset.
  bool voicedRun() const { return runMs_ > 0; }
  bool ended() const { return ended_ != VadEnd::kNone; }
  VadEnd endReason() const { return ended_; }
  // From the onset to the end of the last speech frame; 0 without an onset.
  uint32_t speechMs() const { return heard_ ? lastSpeechEndMs_ - onsetMs_ : 0; }
  // The end of the last speech frame since reset() (frame time); 0 without an onset.
  uint32_t speechEndMs() const { return heard_ ? lastSpeechEndMs_ : 0; }

 private:
  uint32_t turnMs_ = 0;
  uint32_t runMs_ = 0;       // onset-level speech accumulated within the active gap limit.
  uint32_t runStartMs_ = 0;
  uint32_t gapMs_ = 0;       // since the last speech frame.
  uint32_t onsetMs_ = 0;
  uint32_t lastSpeechEndMs_ = 0;
  uint32_t onsetNeedMs_ = kVadOnsetMs;
  uint32_t endSilenceMs_ = kVadEndSilenceMs;
  VadOnset onsetPolicy_ = VadOnset::kWake;
  bool inRun_ = false;       // the previous frame was speech: the hold level applies.
  bool heard_ = false;
  VadEnd ended_ = VadEnd::kNone;
};

}  // namespace bob
