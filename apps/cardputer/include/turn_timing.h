// Bob Cardputer v2 — the per-turn timing summary (turn_timing, #1004).
//
// Every milestone is a millis() reading on this device's monotonic clock, kept
// as an offset from the turn's capture start with wrap-safe uint32 arithmetic
// (millis() rolls over every ~49.7 days). Offsets are never compared with the
// server's clock. Per milestone the wire says: a number (measured, 0 is real),
// null (skipped: the step did not happen this turn) or nothing (unknown: no
// measurement, or more than kTurnTimingMaxMs after capture start).
//
// speaker_submission is the first audio the speaker API (M5 Speaker playRaw)
// accepted, not audible onset: the I2S DMA and the amplifier follow it, and
// acoustic output is not measured.
//
// Capture stats (appended after down_frames, set once when the mic closes in
// endTurn): speech_end_ms is the end of the VAD's last voiced frame on the
// VAD's audio clock (10 ms per mic frame), moved to capture start: a
// follow-up turn's VAD first hears its pre-roll, which predates capture start
// by audioLeadMs, so that much is taken off (a speech end inside the pre-roll
// reads 0). It matches the millis() offsets while capture is gap-free (mic_fps 100). The VAD hears
// every turn, push-to-talk included, so it is sent for every source: null
// when no onset was heard. uplink_backlog is the frames still queued when the
// mic closed, mic_fps the mic's delivered frame rate, tx_busy / tx_busy_max_ms
// the socket's refused writes and its longest busy streak this turn. A turn
// that never reached endTurn (a no_speech cancel) leaves all five out. They
// are best effort: speech_end_ms, then the other four as one block, each only
// when it still fits under kTurnTimingBytes (every required field at its bound
// with a 64-char ref leaves room for speech_end_ms only). Sent once per turn, only after a welcome
// acknowledged "turn_timing", after the reply drained, was stopped or failed.
// Pure logic (host-tested in test/host/test_turn_timing.cpp).
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <initializer_list>

namespace bob {

// apps/api/src/voice/protocol-timing.ts DEVICE_TIMING_MAX_MS / _MAX_FRAMES.
constexpr uint32_t kTurnTimingMaxMs = 600000;
constexpr uint32_t kTurnTimingMaxFrames = 100000;
// The control queue refuses a message of kControlMaxBytes (512) or more.
constexpr size_t kTurnTimingBytes = 512;

// Wire order of the milestones (protocol-timing.ts TURN_TIMING_MILESTONES).
enum class Milestone : uint8_t {
  kCaptureEnd,         // the mic closed (endpointer, GO release, ...).
  kFirstUp,            // the socket took the turn's first audio_up frame.
  kTurnEnd,            // turn_end was queued for the socket.
  kPlaybackStart,      // this turn's playback_start control was accepted.
  kFirstDown,          // the reply's first audio_down frame reached playback.
  kDecoderReady,       // MP3 decoder begin() succeeded (PCM: skipped).
  kSpeakerSubmission,  // the speaker API accepted the first reply samples.
  kPlaybackEnd,        // the reply was torn down: drained, stopped or failed.
  kCount,
};
constexpr size_t kMilestoneCount = static_cast<size_t>(Milestone::kCount);

enum class TimingSource : uint8_t { kPtt, kWake, kFollowUp };
enum class TimingEnd : uint8_t { kRelease, kSilence, kMax, kKey, kUplink, kNoSpeech, kError };
enum class TimingOutcome : uint8_t { kDrained, kEmpty, kInterrupted, kFailed, kCancelled };

inline const char* timingSourceName(TimingSource v) {
  switch (v) {
    case TimingSource::kPtt: return "ptt";
    case TimingSource::kWake: return "wake";
    case TimingSource::kFollowUp: return "follow_up";
  }
  return "ptt";
}

inline const char* timingEndName(TimingEnd v) {
  switch (v) {
    case TimingEnd::kRelease: return "release";
    case TimingEnd::kSilence: return "silence";
    case TimingEnd::kMax: return "max";
    case TimingEnd::kKey: return "key";
    case TimingEnd::kUplink: return "uplink";
    case TimingEnd::kNoSpeech: return "no_speech";
    case TimingEnd::kError: return "error";
  }
  return "error";
}

// The capture end reasons state_turn.cpp journals ("release", "silence", ...).
inline TimingEnd timingEndFromName(const char* name) {
  if (name == nullptr) return TimingEnd::kError;
  // The server's end of turn is an endpointing decision, so it is a silence end on the wire
  // (the server itself journals eot_source=server).
  if (std::strcmp(name, "server") == 0) return TimingEnd::kSilence;
  const TimingEnd all[] = {TimingEnd::kRelease, TimingEnd::kSilence, TimingEnd::kMax,
                           TimingEnd::kKey, TimingEnd::kUplink, TimingEnd::kNoSpeech};
  for (TimingEnd end : all) {
    if (std::strcmp(name, timingEndName(end)) == 0) return end;
  }
  return TimingEnd::kError;
}

inline const char* timingOutcomeName(TimingOutcome v) {
  switch (v) {
    case TimingOutcome::kDrained: return "drained";
    case TimingOutcome::kEmpty: return "empty";
    case TimingOutcome::kInterrupted: return "interrupted";
    case TimingOutcome::kFailed: return "failed";
    case TimingOutcome::kCancelled: return "cancelled";
  }
  return "failed";
}

inline const char* milestoneKey(Milestone m) {
  static const char* const kKeys[kMilestoneCount] = {
      "capture_end_ms", "first_up_ms", "turn_end_ms", "playback_start_ms",
      "first_down_ms", "decoder_ready_ms", "speaker_submission_ms", "playback_end_ms"};
  const size_t i = static_cast<size_t>(m);
  return i < kMilestoneCount ? kKeys[i] : "";
}

// One millis() stamp: unset until the first mark (later marks are ignored).
// Written by one task, read by the main loop; `set` is published after `at`.
struct TimingStamp {
  volatile uint32_t at = 0;
  volatile bool set = false;
  void mark(uint32_t now) {
    if (set) return;
    at = now;
    set = true;
  }
  void clear() {
    set = false;
    at = 0;
  }
};

// Playback's own stamps (audio_playback.cpp), copied into the turn's record
// when the turn ends. `decoder` is false for PCM, which has no decoder.
struct PlaybackStamps {
  TimingStamp start;
  TimingStamp firstDown;
  TimingStamp decoderReady;
  TimingStamp submitted;
  TimingStamp ended;
  bool decoder = false;
  bool failed = false;   // no buffer, no decoder (begin failed, heap) or no decode task.
  uint32_t downFrames = 0;
  void clear() {
    start.clear();
    firstDown.clear();
    decoderReady.clear();
    submitted.clear();
    ended.clear();
    decoder = false;
    failed = false;
    downFrames = 0;
  }
};

// The turn's record: capture start, its stamps and how it ended.
struct TurnTimingRecord {
  bool active = false;  // open: begun for a turn the server knows, not closed yet.
  bool closed = false;  // close() ran: every milestone is measured, skipped or unknown.
  uint32_t startedAt = 0;  // capture start (millis()).
  uint32_t audioLeadMs = 0;  // VAD audio heard before capture start (follow-up pre-roll).
  TimingSource source = TimingSource::kPtt;
  TimingEnd end = TimingEnd::kError;
  bool endSet = false;
  bool muted = false;
  uint32_t upFrames = 0;
  uint32_t downFrames = 0;
  bool statsSet = false;     // setCaptureStats() ran (endTurn).
  bool speechHeard = false;  // the VAD heard an onset: speechEndMs is measured.
  uint32_t speechEndMs = 0;  // already an offset from capture start (audio clock).
  uint32_t uplinkBacklog = 0;
  uint32_t micFps = 0;
  uint32_t txBusy = 0;
  uint32_t txBusyMaxMs = 0;
  uint32_t stamps[kMilestoneCount] = {};
  bool measured[kMilestoneCount] = {};
  bool skipped[kMilestoneCount] = {};  // known not to happen this turn (null on the wire).

  void begin(TimingSource src, uint32_t now, uint32_t leadMs = 0) {
    *this = TurnTimingRecord();
    active = true;
    source = src;
    startedAt = now;
    audioLeadMs = leadMs;
  }
  // The first mark of a milestone wins; nothing is recorded once closed.
  void mark(Milestone m, uint32_t now) {
    const size_t i = static_cast<size_t>(m);
    if (!active || measured[i]) return;
    stamps[i] = now;
    measured[i] = true;
  }
  // The first call wins; nothing is recorded once closed.
  void setCaptureStats(bool heard, uint32_t speechEnd, uint32_t backlog, uint32_t fps,
                       uint32_t busy, uint32_t busyMaxMs) {
    if (!active || statsSet) return;
    statsSet = true;
    speechHeard = heard;
    speechEndMs = speechEnd > audioLeadMs ? speechEnd - audioLeadMs : 0;  // VAD clock to capture start.
    uplinkBacklog = backlog;
    micFps = fps;
    txBusy = busy;
    txBusyMaxMs = busyMaxMs;
  }
  void setEnd(TimingEnd reason) {
    if (!active || endSet) return;
    end = reason;
    endSet = true;
  }
  // Ends the record: capture steps the turn never reached are skipped, and
  // playback's stamps are copied (a step playback never reached is skipped;
  // PCM has no decoder, so decoder_ready is skipped for it).
  void close(const PlaybackStamps& p) {
    if (!active) return;
    for (Milestone m : {Milestone::kCaptureEnd, Milestone::kFirstUp, Milestone::kTurnEnd}) {
      skipUnlessMeasured(m);
    }
    take(Milestone::kPlaybackStart, p.start, true);
    take(Milestone::kFirstDown, p.firstDown, true);
    take(Milestone::kDecoderReady, p.decoderReady, p.decoder);
    take(Milestone::kSpeakerSubmission, p.submitted, true);
    take(Milestone::kPlaybackEnd, p.ended, true);
    downFrames = p.downFrames;
    active = false;
    closed = true;
  }

  // The wire value of one milestone: true with `out` set when measured.
  // `isNull` when skipped; neither when unknown (or past kTurnTimingMaxMs).
  bool offset(Milestone m, uint32_t* out, bool* isNull) const {
    const size_t i = static_cast<size_t>(m);
    *isNull = false;
    if (measured[i]) {
      const uint32_t delta = static_cast<uint32_t>(stamps[i] - startedAt);  // wrap-safe.
      if (delta > kTurnTimingMaxMs) return false;
      *out = delta;
      return true;
    }
    *isNull = skipped[i];
    return false;
  }

 private:
  void skipUnlessMeasured(Milestone m) {
    const size_t i = static_cast<size_t>(m);
    if (!measured[i]) skipped[i] = true;
  }
  void take(Milestone m, const TimingStamp& from, bool applies) {
    if (applies && from.set) {
      mark(m, from.at);
    } else {
      skipUnlessMeasured(m);
    }
  }
};

// The outcome from what the turn saw: a local stop, a server or decoder
// failure, or how much of the reply reached the speaker.
inline TimingOutcome timingOutcome(bool stopped, bool failed, const PlaybackStamps& p) {
  if (stopped) return TimingOutcome::kInterrupted;
  if (failed || p.failed) return TimingOutcome::kFailed;
  if (!p.start.set || p.downFrames == 0) return TimingOutcome::kEmpty;
  if (!p.submitted.set) return TimingOutcome::kFailed;  // frames arrived, nothing played.
  return TimingOutcome::kDrained;
}

inline bool turnTimingRefAllowed(const char* ref) {
  if (ref == nullptr) return false;
  size_t n = 0;
  for (; ref[n] != '\0' && n <= 64; ++n) {
    const char c = ref[n];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
          c == '_' || c == '-')) {
      return false;
    }
  }
  return n >= 8 && n <= 64;
}

inline bool welcomeSupportsTurnTiming(const char* welcome) {
  return welcome != nullptr && std::strstr(welcome, "\"turn_timing\":true") != nullptr;
}

// Appends `block` (snprintf's length `n`) at `used` when it leaves `reserve`
// more bytes and the terminator; otherwise leaves `out` as it was.
inline size_t appendIfRoom(char* out, size_t capacity, size_t used, const char* block, int n, size_t reserve) {
  if (n <= 0 || used + static_cast<size_t>(n) + reserve >= capacity) return used;
  std::memcpy(out + used, block, static_cast<size_t>(n) + 1);
  return used + static_cast<size_t>(n);
}

// Writes the turn_timing message for `ref` into `out` (kTurnTimingBytes).
// Returns its length, or 0 (out empty) for a bad ref, no capacity or a
// record that was not closed. `idStamp` makes the envelope id (tmg_<n>_v2).
inline size_t encodeTurnTiming(char* out, size_t capacity, const char* ref,
                               const TurnTimingRecord& r, TimingOutcome outcome,
                               uint32_t idStamp) {
  if (out == nullptr || capacity == 0) return 0;
  out[0] = '\0';
  if (capacity < kTurnTimingBytes || !r.closed || !turnTimingRefAllowed(ref)) return 0;
  int n = std::snprintf(out, capacity,
                        "{\"v\":1,\"type\":\"turn_timing\",\"id\":\"tmg_%lu_v2\",\"turn_ref\":\"%s\","
                        "\"payload\":{\"version\":1,\"source\":\"%s\",\"end_reason\":\"%s\","
                        "\"outcome\":\"%s\",\"muted\":%s",
                        static_cast<unsigned long>(idStamp), ref, timingSourceName(r.source),
                        timingEndName(r.endSet ? r.end : TimingEnd::kError),
                        timingOutcomeName(outcome), r.muted ? "true" : "false");
  size_t used = n > 0 ? static_cast<size_t>(n) : capacity;
  for (size_t i = 0; i < kMilestoneCount && used < capacity; ++i) {
    uint32_t value = 0;
    bool isNull = false;
    const Milestone m = static_cast<Milestone>(i);
    if (r.offset(m, &value, &isNull)) {
      n = std::snprintf(out + used, capacity - used, ",\"%s\":%lu", milestoneKey(m),
                        static_cast<unsigned long>(value));
    } else if (isNull) {
      n = std::snprintf(out + used, capacity - used, ",\"%s\":null", milestoneKey(m));
    } else {
      continue;  // unknown: left out.
    }
    used = n > 0 ? used + static_cast<size_t>(n) : capacity;
  }
  if (used < capacity) {
    const uint32_t up = r.upFrames > kTurnTimingMaxFrames ? kTurnTimingMaxFrames : r.upFrames;
    uint32_t down = 0;
    if (r.measured[static_cast<size_t>(Milestone::kFirstDown)]) down = r.downFrames;
    if (down > kTurnTimingMaxFrames) down = kTurnTimingMaxFrames;
    n = std::snprintf(out + used, capacity - used, ",\"up_frames\":%lu,\"down_frames\":%lu",
                      static_cast<unsigned long>(up), static_cast<unsigned long>(down));
    used = n > 0 ? used + static_cast<size_t>(n) : capacity;
  }
  // Optional capture stats: each block only when it still fits with the closing
  // "}}" (the worst case of every field cannot), speech_end_ms first.
  if (r.statsSet && used < capacity) {
    char block[160];
    if (!r.speechHeard) {
      n = std::snprintf(block, sizeof(block), ",\"speech_end_ms\":null");
    } else if (r.speechEndMs <= kTurnTimingMaxMs) {
      n = std::snprintf(block, sizeof(block), ",\"speech_end_ms\":%lu", static_cast<unsigned long>(r.speechEndMs));
    } else {
      n = 0;  // unknown: left out.
    }
    used = appendIfRoom(out, capacity, used, block, n, 2);
    const auto cap = [](uint32_t v, uint32_t bound) { return static_cast<unsigned long>(v > bound ? bound : v); };
    n = std::snprintf(block, sizeof(block),
                      ",\"uplink_backlog\":%lu,\"mic_fps\":%lu,\"tx_busy\":%lu,\"tx_busy_max_ms\":%lu",
                      cap(r.uplinkBacklog, kTurnTimingMaxFrames), cap(r.micFps, kTurnTimingMaxFrames),
                      cap(r.txBusy, kTurnTimingMaxFrames), cap(r.txBusyMaxMs, kTurnTimingMaxMs));
    used = appendIfRoom(out, capacity, used, block, n, 2);
  }
  if (used < capacity) {
    n = std::snprintf(out + used, capacity - used, "}}");
    used = n > 0 ? used + static_cast<size_t>(n) : capacity;
  }
  if (used >= capacity) {
    out[0] = '\0';
    return 0;
  }
  return used;
}

}  // namespace bob
