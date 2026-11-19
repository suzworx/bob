// Touch input of the Waveshare round screen. Turns finger samples into the round screen's own actions
// (a tap is GO, a tap on Bob giggles and shows the info view: touch::intentFor) and otherwise into the same
// Keyboard_Class::KeysState the Cardputer keyboard produces (through board::keys() / keysChanged() /
// anyKeyPressed()). Push-to-talk is the BOOT button only. The tables are in touch_policy.h (host-tested).
#pragma once

#if defined(BOB_BOARD_WAVESHARE_185C)

#include <stdint.h>

#include "board.h"
#include "touch_policy.h"

namespace bob
{
namespace fsm
{
// state_turn.cpp endTurn() reports a turn that is closing; the GO loop breaker counts tap-started turns nobody spoke in.
void touchTurnEnded(bool heardSpeech);
} // namespace fsm

namespace roundtouch
{

// Replays the touch samples a sampler task queued (one per 33 ms, each with its own time), the gesture, and the
// next key frame. Called from board::update() once per loop pass.
void poll(uint32_t nowMs);

// What board::keysChanged() / keys() / anyKeyPressed() report. A tap is one press frame then one empty
// frame, like the HIL console's testPressAndRelease. A touch held in the first 1.5 s after boot reads as
// Fn + ` (the rescue chord) through keys() only: it never reports a change, so it opens nothing later.
bool keysChanged();
const Keyboard_Class::KeysState& keys();
bool anyKeyPressed();

#ifdef BOB_TEST_CONSOLE
// hil only: feed a finger path to poll() instead of the panel (T touch / T swipe).
void injectGesture(int16_t x0, int16_t y0, int16_t x1, int16_t y1, uint32_t ms);
bool injectedPoint(uint32_t nowMs, int16_t* x, int16_t* y);
#endif

// A tap on Bob on Ready opens the info view (after his giggle). The view is built elsewhere; the default does nothing.
void onBobTapped();

// --- round_keyboard.cpp: the on-screen keyboard of text-field screens --------------------------
// Called by roundui::noteFieldScreen() right after the field screen cleared the framebuffer.
void keyboardOnFieldScreen(bool digitsOnly);
bool keyboardVisible();
touch::KbLayer keyboardLayer();
void keyboardToggleShift();
void keyboardToggleLayer();
// A character was typed: a one-shot shift falls back to lowercase.
void keyboardTyped();
// Lights the key under (x, y) for a moment; keyboardTick() restores it. Both draw into the framebuffer.
void keyboardPressAt(int16_t x, int16_t y, uint32_t nowMs);
void keyboardTick(uint32_t nowMs);

} // namespace roundtouch
} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
