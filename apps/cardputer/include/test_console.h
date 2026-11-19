// Bob Cardputer v2 — the HIL serial test console (docs/cardputer/hil.md).
// Compiled only into the m5stack-cardputer-hil env (-DBOB_TEST_CONSOLE=1);
// the product build has none of it.
#pragma once

#ifdef BOB_TEST_CONSOLE

#include <WString.h>
#include <cstdint>

namespace bob {

// Reads Serial without blocking and runs at most one complete `T …` line per
// call. Called from the main loop.
void testConsolePoll();

// Hooks into the state machine (state.cpp). Keys and GO go through the same
// dispatchers as the real keyboard and button.
void testPressKey(char c);
void testPressEnter();
void testPressDel();   // Del (#677)
void testPressTab();   // Tab: show or hide a password (#677)
void testPressFn(char c);  // Fn + c: Fn+, Fn+/ move the cursor, Fn+` cancels (#677)
void testSetGo(bool down);
String testStateLine();  // "state=READY mode=ptt vol=5 muted=0 dnd=0"
void testArmTone(uint32_t ms);
// `T wake fire`: the next wake tick acts as a detection. False (nothing
// armed) unless Always awake is listening.
bool testFireWake();
// `T state reset`: loop_max and tx_drop back to 0 (one HIL scenario each).
void testResetCounters();
// `T wake word <alexa|bob>`: sets the wake word; false for an unknown name.
bool testSetWakeWord(const char* name);
bool testSetWakeWire(const char* name);  // `T wake bob`

}  // namespace bob

#endif  // BOB_TEST_CONSOLE
