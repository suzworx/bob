// Bob Cardputer v2 — short generated tones for state changes and the
// announcement ring loop.
#include "earcons.h"
#include "audio_hang.h"
#include "earcons_wave.h"

#include <M5Cardputer.h>
#include "settings.h"
#include "types.h"
#if defined(BOB_BOARD_WAVESHARE_185C)
#include "audio_duplex.h"
#include "ws185_hw.h"
#endif

namespace bob {

namespace {

// Earcons mix on their own virtual channel; replies use channel 0.
constexpr uint8_t kEarconChannel = 7;

// A duplex reply owns I2S0 and the amp (#1364): nothing here may touch either until it ends.
bool duplexOwnsSpeaker() {
#if defined(BOB_BOARD_WAVESHARE_185C)
  return duplex::active();
#else
  return false;
#endif
}

// Waveshare: the speaker amplifier (GPIO15) is switched with the speaker driver; no-op elsewhere.
void setAmp(bool on) {
#if defined(BOB_BOARD_WAVESHARE_185C)
  if (duplex::active()) return;
  ws185::ampEnable(on);
#else
  (void)on;
#endif
}

bool g_pinsStale = true;
bool g_held = false;  // a reply holds the speaker (holdSpeaker).
SpeakerIdle g_idle;
RingSchedule g_ring;
// True when a tone may play now. Never opens the speaker over a running mic.
bool speakerReady() {
  if (speakerGain() == 0 || M5Cardputer.Mic.isRunning() || duplexOwnsSpeaker()) return false;
  if (g_pinsStale || !M5Cardputer.Speaker.isRunning()) {
    restartSpeaker();
    g_pinsStale = false;
  }
  applySpeakerGain();
  // Cabin sounds retain channel gain with digital headroom (types.h).
  M5Cardputer.Speaker.setChannelVolume(
      kEarconChannel, toneChannelVolume(M5Cardputer.Speaker.getChannelVolume(0)));
  return M5Cardputer.Speaker.isRunning();
}

}  // namespace

void playEarcon(Earcon earcon) {
  // Interaction cues yield to speech, an existing cue and DND. Ring alarms
  // keep their separate, user-selected sound and scheduling semantics.
  if (settings().dnd || (g_held && M5Cardputer.Speaker.isRunning()) ||
      M5Cardputer.Speaker.isPlaying()) return;
  if (!speakerReady()) return;
  const ChimeClip pcm = chimeClip(earcon);
  M5Cardputer.Speaker.playRaw(pcm.samples, pcm.count, kChimeRate, false, 1, kEarconChannel);
}

void waitForEarcon(uint32_t maxMs) {
  const uint32_t start = millis();
  while (M5Cardputer.Speaker.isPlaying(kEarconChannel) && millis() - start < maxMs) {
    delay(1);
  }
}

bool earconPlaying() { return M5Cardputer.Speaker.isPlaying(kEarconChannel); }
void stopEarcon() { M5Cardputer.Speaker.stop(kEarconChannel); }

void markSpeakerPinsStale() { g_pinsStale = true; }

void releaseSpeakerForMic() {
  g_pinsStale = true;
#if defined(BOB_BOARD_WAVESHARE_185C)
  if (duplex::active()) return;  // the duplex reply ends first (playback.abort()/teardown)
  // One I2S port serves speaker and mic here: Mic.begin() takes the driver out from under a
  // live speaker task, and the later Speaker.end() then never returns (the turn hangs on
  // LISTENING). Stop the speaker first; the next earcon or reply re-installs it.
  if (M5Cardputer.Speaker.isRunning()) {
    AudioCall guard(AudioStage::kSpeakerEnd, millis());
    M5Cardputer.Speaker.end();
  }
  setAmp(false);
#endif
}

void restartSpeaker() {
  if (M5Cardputer.Speaker.isRunning()) {
    AudioCall guard(AudioStage::kSpeakerEnd, millis());
    M5Cardputer.Speaker.end();
  }
  {
    AudioCall guard(AudioStage::kSpeakerBegin, millis());
    M5Cardputer.Speaker.begin();
  }
#if defined(BOB_BOARD_WAVESHARE_185C)
  // The DAC's output path is re-asserted before every reply and tone: if the ES8311 lost a register
  // (a dropped I2C write at boot, a codec reset), playback would run its whole length in silence (#1063).
  ws185::dacEnsure();
#endif
  setAmp(true);
}

void holdSpeaker(bool held) { g_held = held; }

void speakerIdleTick(uint32_t nowMs) {
  if (duplexOwnsSpeaker()) return;  // M5.Speaker is stopped by design; the amp and I2S0 are not ours.
  auto& speaker = M5Cardputer.Speaker;
  if (g_idle.tick(nowMs, speaker.isRunning(), speaker.isPlaying(), g_held,
                  M5Cardputer.Mic.isRunning())) {
    AudioCall guard(AudioStage::kSpeakerEnd, millis());
    speaker.end();  // the amp stops hissing; the next tone re-installs it.
  }
  if (!speaker.isRunning()) setAmp(false);  // however the speaker ended, the amp must not hiss.
}

void ringStart(uint32_t nowMs, RingSound sound, uint8_t seconds, bool alarm) {
  M5Cardputer.Speaker.stop(kEarconChannel);
  g_ring.start(nowMs, sound, seconds, alarm);
  ringTick(nowMs);  // the first note plays at once.
}

void ringStop() {
  if (!g_ring.active()) return;
  g_ring.stop();
  M5Cardputer.Speaker.stop(kEarconChannel);
}

bool ringing() { return g_ring.active(); }

uint32_t ringElapsedMs(uint32_t nowMs) { return g_ring.elapsedMs(nowMs); }

bool ringTick(uint32_t nowMs) {
  RingNote note{};
  switch (g_ring.tick(nowMs, &note)) {
    case RingStep::kExpired:
      M5Cardputer.Speaker.stop(kEarconChannel);
      return true;
    case RingStep::kPlay:
      if (speakerReady()) {
        const ChimeClip pcm = ringClip(note.hz);
        // Immutable flash remains safe even if stop/channel retirement is asynchronous.
        M5Cardputer.Speaker.playRaw(pcm.samples, pcm.count, kChimeRate, false, 1, kEarconChannel, true);
      }
      return false;
    case RingStep::kNone:
      return false;
  }
  return false;
}

}  // namespace bob
