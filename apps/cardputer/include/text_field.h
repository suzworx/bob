// Bob Cardputer v2 — the on-device text field (#677; pure, host-tested).
// One field widget for Wi-Fi names, passwords and (later) server hosts on the
// Cardputer keyboard. Inside a field every printable key types -- including
// ` ; . , / which navigate elsewhere -- so navigation needs Fn: Fn+, and Fn+/
// move the cursor, Fn+` cancels. Del erases, Tab shows or hides a masked
// value, Enter submits. A masked field shows the last typed character for
// kRevealMs, then a '*'.
//
// Keyboard facts (M5Cardputer 1.1.x Keyboard::updateKeysState, read from the
// pinned library): `word` holds every printable key HELD right now (space
// included), shifted when Shift, Ctrl or Caps Lock is on; Fn does not change
// `word`; a release also counts as a change. So a new key press is a
// character in this state's `word` that was not in the previous one.
#pragma once

#include <cstddef>
#include <cstdint>

namespace bob {

constexpr size_t kTextFieldMaxBytes = 64;
constexpr size_t kHeldKeysMax = 8;
constexpr uint32_t kRevealMs = 1000;
constexpr uint32_t kRepeatDelayMs = 400;
constexpr uint32_t kRepeatIntervalMs = 60;

struct TextField {
  char text[kTextFieldMaxBytes + 1];
  uint8_t length;
  uint8_t cursor;       // 0..length
  uint8_t maxLength;    // <= kTextFieldMaxBytes
  bool masked;          // a password
  bool shown;           // Tab toggled the mask off
  bool digitsOnly;      // a port
  uint32_t revealUntilMs;  // last typed char visible until then
};

// One keyboard change, reduced to what a field needs.
struct FieldKeys {
  const char* pressed;  // characters newly pressed (see fieldNewlyPressed)
  size_t pressedCount;
  bool enter;
  bool del;
  bool tab;
  bool fn;
};

enum class FieldAction : uint8_t { kNone, kChanged, kSubmit, kCancel };

void fieldInit(TextField& field, uint8_t maxLength, bool masked, const char* initial = "");

// Characters in `now` that were not held in `before`; returns how many were
// written to `out` (at most outCap).
size_t fieldNewlyPressed(const char* before, size_t beforeCount, const char* now, size_t nowCount,
                         char* out, size_t outCap);

FieldAction fieldApply(TextField& field, const FieldKeys& keys, uint32_t nowMs);

// Del held: true when another erase is due. `heldSinceMs` is when the key went
// down; `lastRepeatMs` the last repeat (0 before the first).
bool fieldRepeatDue(uint32_t nowMs, uint32_t heldSinceMs, uint32_t lastRepeatMs);

// What the field shows: at most `columns` characters around the cursor,
// masked unless shown (the last typed character stays visible until
// revealUntilMs). `cursorColumn` is where the cursor falls in `out`.
void fieldRender(const TextField& field, uint32_t nowMs, size_t columns, char* out, size_t outSize,
                 size_t* cursorColumn);

}  // namespace bob
