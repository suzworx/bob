// Bob Cardputer v2 — compile-time configuration and wire constants.
// Secrets (Wi-Fi, host, port) live in include/secrets.h; this header provides
// typed defaults and the protocol frame layout constants shared by all modules.
#pragma once

#if __has_include("secrets.h")
#include "secrets.h"
#endif

#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif
#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD ""
#endif
#ifndef V2_HOST
#define V2_HOST ""
#endif
#ifndef V2_PORT
#define V2_PORT 7444
#endif
// wss:// + Bearer auth; overridable in secrets.h. 0 / "" = plain LAN defaults.
#ifndef V2_USE_TLS
#define V2_USE_TLS 0
#endif
// DEVICE_SECRET is the legacy shared-secret device credential. It is compiled
// in only when the build defines BOB_LEGACY_SECRET=1 (contract S-6): paired
// devices use an NVS token instead, so no shared secret ships in firmware
// (FR-018). Without the flag, DEVICE_SECRET is never defined.
#ifdef BOB_LEGACY_SECRET
#ifndef DEVICE_SECRET
#define DEVICE_SECRET ""
#endif
#endif

// Automated end-to-end turn test seam. When the build defines BOB_AUTO_TURN,
// the device starts turns on its own (no button press) every GAP_MS while in
// READY, capturing CAPTURE_MS of mic frames, so a harness can drive the full
// turn/playback path against a live server with no human. Both are overridable
// with -D; compiled out entirely when BOB_AUTO_TURN is undefined.
#ifndef BOB_AUTO_TURN_GAP_MS
#define BOB_AUTO_TURN_GAP_MS 20000
#endif
#ifndef BOB_AUTO_TURN_CAPTURE_MS
#define BOB_AUTO_TURN_CAPTURE_MS 800
#endif

namespace bob {
namespace config {

// Audio pipeline constants.
constexpr uint32_t kSampleRateHz = 16000;
constexpr size_t kSamplesPerFrame = 160;  // 10 ms PCM16 at 16 kHz.
constexpr size_t kHeaderBytes = 20;
constexpr size_t kPcmFrameBytes = kHeaderBytes + kSamplesPerFrame * sizeof(int16_t);

// Connection and timing.
constexpr uint32_t kSocketAttemptTimeoutMs = 10000;
constexpr uint32_t kSocketReconnectInitialMs = 1000;
constexpr uint32_t kSocketReconnectMaxMs = 30000;
// Capture is continuous: the mic delivers one 10 ms frame every kFrameMs
// (100 frames/s) into the capture ring (audio_capture.h), and each loop takes
// every finished frame. (Until CP-WAKE-MIC the loop took one frame per 12 ms
// timer from a buffer the mic was still filling: 82-88 frames/s, torn audio.)
constexpr uint32_t kFrameMs = 10;

// GO must be held this long before a turn reaches the server; a shorter press
// is a tap and sends nothing (2026-09-24: a tap sent turn_start, one 10 ms
// frame and turn_end, and the server failed the turn with INTERNAL). The mic
// only opens after the ~150 ms listen earcon, so a 300 ms hold carries at
// most ~15 frames (~150 ms) of audio: less than one spoken word, nothing STT
// can transcribe.
// The frames captured before the hold qualifies (~15 at 100 frames/s: the
// hold is timed from the press, before the ~150 ms earcon) wait in the turn's
// uplink queue and go out right behind turn_start, paced with the live ones
// (include/uplink_queue.h has the queue, its bound and the send budget).
constexpr uint32_t kGoMinHoldMs = 300;

constexpr uint32_t kMinReplyDisplayMs = 1500;
constexpr uint32_t kWifiHeartbeatMs = 10000;
constexpr uint32_t kDownlinkStallThresholdMs = 1000;  // No frame for this long = stalled.

// PCM16 downlink ring (#674): 1.5 s at 16 kHz, streamed, never the whole
// reply (the old 320 KB/160 KB whole-reply block never fit: the largest free
// block is 159732 B in ptt, wake and announce_only). Same bytes as the MP3
// ring, which runs in every mode alongside a ~70 KB decoder, so the server can
// pace PCM with the MP3 ring model (MP3_TARGET_BUFFER_BYTES = 32 KB of 48 KB).
constexpr size_t kPcmRingBufferBytes = 48 * 1024;
// Playback starts (and restarts after an underrun) once 0.5 s is buffered, or
// at playback_end for a shorter reply.
constexpr size_t kPcmPrebufferBytes = 16 * 1024;
// One speaker queue slot: 128 ms. Two queued slots cover a 256 ms loop stall
// (loop_max ~130 ms in HIL); three chunk buffers are 12 KB.
constexpr size_t kPcmChunkSamples = 2048;

// MP3 streaming ring buffer. 48 KB gives ~30 s at 12.8 kbps or ~3 s at 128 kbps,
// more than enough to absorb the 20 ms-paced 1 KB server chunks.
constexpr size_t kMp3RingBufferBytes = 48 * 1024;

// Minimum internal heap required before AudioGeneratorMP3 begins decoding; below
// this the decoder's per-frame mallocs fail and null-deref (Guru Meditation).
constexpr size_t kMp3MinDecodeHeapBytes = 32 * 1024;

// I2S output for MP3 path uses the same pins M5Unified configures for the
// Cardputer speaker: I2S_NUM_1, BCLK=41, WS=43, DOUT=42.
constexpr int kSpeakerI2sPort = 1;
constexpr int kSpeakerBclkPin = 41;
constexpr int kSpeakerWsPin = 43;
constexpr int kSpeakerDoutPin = 42;

// OLX2 frame header byte layout.
constexpr uint8_t kFrameMagic[4] = {'O', 'L', 'X', '2'};
constexpr uint8_t kFrameVersion = 1;
constexpr uint8_t kKindAudioUp = 1;
constexpr uint8_t kKindAudioDown = 2;

// Audio format ids, matching apps/api/schemas.ts.
constexpr uint8_t kFormatPcm16 = 1;
constexpr uint8_t kFormatMp3 = 2;

// Downlink payload size bounds (apps/api/src/schemas.ts ~31-34).
constexpr size_t kMaxPcmPayloadBytes = 320;
constexpr size_t kMaxMp3PayloadBytes = 1024;

// Maximum WebSocket frame size the device accepts: above largest server control message (10-entry conversations list, ~13 KB worst case) and audio frames.
constexpr size_t kMaxRxFrameBytes = 16 * 1024;

}  // namespace config
}  // namespace bob
