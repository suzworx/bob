// Bob Cardputer v2 — on-device wake word and end-of-speech detection.
//
// Wake word: microWakeWord streaming model on TFLite Micro, fed 10 ms PCM16
// 16 kHz mono frames. Alexa and Hey Bob are in flash; the private build
// swaps in the untracked Hey Bob candidate (wake_models.h). One runs at a time, in the one arena.
// Nothing here sends, stores or logs audio; frames are consumed and dropped.
//
// End of speech: energy VAD with an adaptive noise floor (end_of_speech.h has
// the rules and constants). vadSpeechEnded() turns true once speech has been
// heard and then kVadHandsFreeEndSilenceMs of silence follows, or at the length cap.
//
// Threading: not thread-safe. Call every function from the task that owns the
// microphone (the main loop today).
#pragma once

#include <cstddef>
#include <cstdint>
#include "end_of_speech.h"
#include "wake_models.h"
#include "wake_stats.h"

namespace bob {

// Allocates the tensor arena and frontend state and loads `word`'s model with
// its cutoff and window. Safe to call again after wakeWordEnd(); to switch
// words, end first. Returns false (and holds no memory) when the heap cannot
// fit the arena or the model does not load.
bool wakeWordBegin(WakeWord word);

// Feeds `n` samples (normally one 10 ms frame of 160). Runs the frontend on
// every 10 ms and the model after its input stride (Alexa 30 ms, Bob 20 ms).
// No-op before wakeWordBegin().
void wakeWordFeed(const int16_t* samples, size_t n);

// While on (Bob is playing, barge_policy.h): detection uses the stricter
// bargeCutoff() and the noise floor is frozen, so the next turn's VAD floor is
// not learned from residual echo. Off restores the model's own cutoff.
void wakeWordSetPlaybackGuard(bool on);

// True once after a detection; reading clears the latch.
bool wakeWordDetected();

// Frees the arena and frontend state. Call before playback or TLS need the heap.
void wakeWordEnd();

// Bytes held while running (tensor arena + frontend), 0 when stopped.
size_t wakeWordArenaBytes();
// Of the tensor arena, the bytes the model actually planned (0 when stopped).
size_t wakeWordArenaUsedBytes();
// Where the tensor arena lives: "internal" (fast) or "psram" (slow on the Waveshare); "none" stopped.
const char* wakeWordArenaRegion();
// Why the last wakeWordBegin() failed: "model_rejected",
// "arena_alloc_failed", "model_init_failed", or "" after a success. The
// module never prints; the caller journals this.
const char* wakeWordLastError();

// Worst and last model Invoke() time in microseconds, for hardware budgeting.
uint32_t wakeWordLastInvokeUs();
uint32_t wakeWordMaxInvokeUs();

// wake_stats telemetry (wake_stats.h): one window per kWakeStatsPeriodMs of
// listening. Due is false while stopped; taking the stats starts a new window.
constexpr uint32_t kWakeStatsPeriodMs = 5000;
bool wakeWordStatsDue(uint32_t nowMs);
WakeStats wakeWordTakeStats(uint32_t nowMs);
// Cost of one 10 ms frame through frontend + model since the previous read (then cleared), and
// frames dropped because the Waveshare wake task's ring was full. Journaled in wake_stats.
struct WakeFeedStats {
  uint32_t frames = 0, avgUs = 0, maxUs = 0, dropped = 0;
};
WakeFeedStats wakeWordTakeFeedStats();
// The adaptive noise floor (dB re one LSB) shared with the VAD; 0 until measured.
float wakeWordNoiseFloorDb();

// Starts end-of-speech tracking for a new turn (clears speech/silence state).
// onsetMs: speech that counts as talking (kFollowUpOnsetMs in the window).
// endSilenceMs: the silence that ends a hands-free turn (700 ms on the round board).
void vadReset(uint32_t onsetMs = kVadOnsetMs, VadOnset policy = VadOnset::kWake,
              uint32_t endSilenceMs = kVadHandsFreeEndSilenceMs);

// Feeds one captured frame of the turn to the end-of-speech tracker.
void vadFeed(const int16_t* samples, size_t n);

// True when the turn should end (end_of_speech.h): speech then
// kVadHandsFreeEndSilenceMs of silence, kVadMaxTurnMs of audio, or kVadNoSpeechMs with
// no speech. Stays true until vadReset().
bool vadSpeechEnded();

// True if any speech was heard since vadReset() (lets the caller drop a turn
// that timed out on pure silence instead of sending it).
bool vadHeardSpeech();

// True while a speech run is under way but short of the onset (end_of_speech.h).
bool vadVoicedRun();

// Why the VAD ended the turn (kNone while it runs), and the speech onset to
// the end of the last speech frame, for turn_ended.
VadEnd vadEndReason();
uint32_t vadSpeechMs();
// The end of the last speech frame since vadReset() (turn_timing speech_end_ms).
uint32_t vadSpeechEndMs();

}  // namespace bob
