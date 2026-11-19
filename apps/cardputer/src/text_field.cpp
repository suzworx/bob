// Bob Cardputer v2 — the on-device text field (see include/text_field.h).
#include "text_field.h"

#include <cstring>

namespace bob {

namespace {

bool accepts(const TextField& field, char c) {
  if (c < 0x20 || c > 0x7e) return false;
  return !field.digitsOnly || (c >= '0' && c <= '9');
}

void insertAtCursor(TextField& field, char c) {
  memmove(field.text + field.cursor + 1, field.text + field.cursor, field.length - field.cursor);
  field.text[field.cursor] = c;
  ++field.length;
  ++field.cursor;
  field.text[field.length] = '\0';
}

void eraseBeforeCursor(TextField& field) {
  memmove(field.text + field.cursor - 1, field.text + field.cursor, field.length - field.cursor);
  --field.length;
  --field.cursor;
  field.text[field.length] = '\0';
}

}  // namespace

void fieldInit(TextField& field, uint8_t maxLength, bool masked, const char* initial) {
  memset(&field, 0, sizeof(field));
  field.maxLength = maxLength > kTextFieldMaxBytes ? kTextFieldMaxBytes : maxLength;
  field.masked = masked;
  if (initial) {
    strncpy(field.text, initial, field.maxLength);
    field.text[field.maxLength] = '\0';
    field.length = static_cast<uint8_t>(strlen(field.text));
    field.cursor = field.length;
  }
}

size_t fieldNewlyPressed(const char* before, size_t beforeCount, const char* now, size_t nowCount,
                         char* out, size_t outCap) {
  size_t written = 0;
  for (size_t i = 0; i < nowCount && written < outCap; ++i) {
    bool held = false;
    for (size_t j = 0; j < beforeCount && !held; ++j) held = before[j] == now[i];
    if (!held) out[written++] = now[i];
  }
  return written;
}

FieldAction fieldApply(TextField& field, const FieldKeys& keys, uint32_t nowMs) {
  if (keys.enter) return FieldAction::kSubmit;
  if (keys.fn) {
    for (size_t i = 0; i < keys.pressedCount; ++i) {
      switch (keys.pressed[i]) {
        case '`': return FieldAction::kCancel;
        case ',':
          if (field.cursor > 0) --field.cursor;
          return FieldAction::kChanged;
        case '/':
          if (field.cursor < field.length) ++field.cursor;
          return FieldAction::kChanged;
        default: break;
      }
    }
    return FieldAction::kNone;  // Fn chords type nothing.
  }
  if (keys.tab) {
    if (!field.masked) return FieldAction::kNone;
    field.shown = !field.shown;
    return FieldAction::kChanged;
  }
  bool changed = false;
  if (keys.del && field.cursor > 0) {
    eraseBeforeCursor(field);
    changed = true;
  }
  for (size_t i = 0; i < keys.pressedCount; ++i) {
    const char c = keys.pressed[i];
    if (!accepts(field, c) || field.length >= field.maxLength) continue;
    insertAtCursor(field, c);
    field.revealUntilMs = nowMs + kRevealMs;
    changed = true;
  }
  return changed ? FieldAction::kChanged : FieldAction::kNone;
}

bool fieldRepeatDue(uint32_t nowMs, uint32_t heldSinceMs, uint32_t lastRepeatMs) {
  if (nowMs - heldSinceMs < kRepeatDelayMs) return false;
  return lastRepeatMs == 0 || nowMs - lastRepeatMs >= kRepeatIntervalMs;
}

void fieldRender(const TextField& field, uint32_t nowMs, size_t columns, char* out, size_t outSize,
                 size_t* cursorColumn) {
  if (outSize == 0) return;
  if (columns + 1 > outSize) columns = outSize - 1;
  // Scroll so the cursor stays inside the window (one column for the cursor).
  size_t start = 0;
  if (columns > 0 && field.cursor >= columns) start = field.cursor - columns + 1;
  size_t n = field.length - start;
  if (n > columns) n = columns;
  const bool revealing = static_cast<int32_t>(field.revealUntilMs - nowMs) > 0;
  for (size_t i = 0; i < n; ++i) {
    const size_t index = start + i;
    const bool plain = !field.masked || field.shown ||
                       (revealing && field.cursor > 0 && index == static_cast<size_t>(field.cursor - 1));
    out[i] = plain ? field.text[index] : '*';
  }
  out[n] = '\0';
  if (cursorColumn) *cursorColumn = field.cursor - start;
}

}  // namespace bob
