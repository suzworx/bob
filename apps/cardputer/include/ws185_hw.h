// Board drivers for the Waveshare ESP32-S3-Touch-LCD-1.85C (V2: ES8311 + ES7210,
// ST77916 QSPI panel, CST816 touch, TCA9554 expander). Everything goes through
// M5Unified/M5GFX: the panel becomes M5.Display, the codecs sit behind
// M5.Speaker/M5.Mic on one shared I2S bus. Pins: src/ws185_hw.cpp.
#pragma once

#if defined(BOB_BOARD_WAVESHARE_185C)

#include <stddef.h>
#include <stdint.h>

#include "speaker_test.h"
#include "touch_policy.h"

namespace bob
{
namespace ws185
{

// Call after M5.begin(): the board is unknown to M5Unified, so it leaves the
// display, speaker, mic and internal I2C unconfigured.

// I2C 11/10 on M5.In_I2C, TCA9554 outputs, pulses the touch (EXIO1) and LCD (EXIO2) resets.
bool beginBus();

// Builds the ST77916 panel on the QSPI bus and makes it M5.Display with a
// viewW x viewH logical size centred in the 360x360 round glass. Backlight on GPIO5.
bool attachDisplay(int16_t viewW, int16_t viewH);

// ES8311 (DAC) and ES7210 (ADC) register init, then M5.Speaker/M5.Mic configured on
// the shared I2S pins. The amp stays off: M5Unified keeps the speaker enable
// callback protected, so the caller brackets playback with ampEnable().
bool beginAudio();

// Speaker amplifier enable (GPIO15, HIGH = on). Forgetting it = silent.
void ampEnable(bool on);
// The level ampEnable() last drove.
bool ampIsOn();

// Re-writes the ES8311 output path (analog power, DAC power, HP drive, unmute, 0 dB) with its init
// values. Idempotent and a few hundred microseconds: restartSpeaker() calls it before the amp goes on.
bool dacEnsure();

// ES8311 readback for the journal: "es8311=83,r0d=01,r12=00,r13=10,r31=00,r32=bf,codec_ok=1".
// True when the chip answers with its id and every output-path register holds its init value.
bool codecState(char* out, size_t n);

// Full-duplex I2S0 (#1364): lets the wake model listen while Bob speaks. Single owner: one task at a
// time drives the port; not thread-safe across tasks. The caller runs a 10 ms block loop, e.g.
// duplexTransfer(out, in, 160, timeout): 160 mono samples out to the speaker and 160 mono samples in
// from the mic, at 16 kHz (the downlink rate the codecs are set up for). duplexBegin() stops
// M5.Speaker and M5.Mic; duplexEnd() frees the port so both can begin() again.
// inMono is unclipped: (L + R) / 2 times M5.Mic's magnification, so it can exceed int16 when the echo is louder
// than the reference (see ws185_hw.cpp for the derivation and the residual).
bool duplexBegin(uint32_t rateHz);
size_t duplexTransfer(const int16_t* outMono, int32_t* inMono, size_t n, uint32_t timeoutMs);
void duplexEnd();
bool duplexActive();

#ifdef BOB_TEST_CONSOLE
// `T spk test` (include/speaker_test.h): takes I2S0 full duplex, plays quiet / tone amp off / tone amp
// on and measures each through the ES7210, then frees the port and turns the amp off. The speaker and
// mic must both be stopped first. False when the I2S driver could not be set up.
bool speakerSelfTest(spktest::Levels* levels, uint32_t* micSamples);
#endif

// Raw ST77916 command (hil console `T panel`): waits for the display, then sends cmd and params.
void panelCommand(uint8_t cmd, const uint8_t* params, uint8_t n);

#if defined(BOB_TEST_CONSOLE)
// hil console panel experiments (#1065, docs/waveshare/navy-1065.md). Each changes the glass only
// until the next boot; the board file remembers what it wrote so `T panel dump` can print it.
void panelGamma(const uint8_t pos[14], const uint8_t neg[14], const char* label); // E0/E1 on the gamma page
void panelGammaCurrent(uint8_t pos[14], uint8_t neg[14]);         // what E0/E1 hold now
void panelInvert(bool on);                  // 0x21 INVON / 0x20 INVOFF
void panelMadctl(uint8_t value);            // 0x36, raw (rotation and BGR bit included)
bool panelInit(const char* table);          // "ws" (product table) | "esp" (Espressif default), whole table
void panelReadId(uint8_t id[4]);            // RDDID (0x04), best effort
// What was written, as one console line: init table, gamma label and bytes, INVON, MADCTL, COLMOD,
// backlight level/duty, and the last raw `T panel` commands.
void panelDump(char* out, size_t n);
#endif

// CST816 read in panel coordinates (0..359); false when no finger is down.
bool touchPoint(int16_t* x, int16_t* y);
// The same read, tri-state: kUnknown for a failed I2C read or a garbage frame (round_touch.cpp feeds it).
// Safe to call from another task: every I2C access in ws185_hw.cpp shares one bus lock.
touch::Sample touchSample(int16_t* x, int16_t* y);

// BOOT button (GPIO0, active low).
bool bootPressed();

// Probe results for the bring-up log: ES8311 chip id (0x83 expected) and ES7210 reg 0x00.
uint8_t es8311Id();
uint8_t es7210Reg0();

} // namespace ws185
} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
