// The on-device text field (include/text_field.h, #677): every printable key
// types (including the keys that navigate elsewhere), Fn chords navigate and
// never type, only newly pressed keys count, Del repeats, and a masked field
// shows the last character briefly.
#include <string>

#include "doctest.h"
#include "text_field.h"

using namespace bob;

namespace {

FieldAction press(TextField& f, const std::string& chars, uint32_t now = 1000, bool fn = false) {
  const FieldKeys keys{chars.data(), chars.size(), false, false, false, fn};
  return fieldApply(f, keys, now);
}

FieldAction special(TextField& f, bool enter, bool del, bool tab, uint32_t now = 1000) {
  const FieldKeys keys{nullptr, 0, enter, del, tab, false};
  return fieldApply(f, keys, now);
}

std::string render(const TextField& f, uint32_t now, size_t columns = 36, size_t* cursor = nullptr) {
  char out[80];
  fieldRender(f, now, columns, out, sizeof(out), cursor);
  return out;
}

}  // namespace

TEST_CASE("every printable ASCII key types itself, navigation keys included") {
  TextField f;
  fieldInit(f, 64, false);
  for (char c = 0x20; c <= 0x7e && f.length < 64; ++c) {
    CAPTURE(c);
    const uint8_t before = f.length;
    CHECK(press(f, std::string(1, c)) == FieldAction::kChanged);
    CHECK(f.length == before + 1);
    CHECK(f.text[f.length - 1] == c);
  }
  TextField g;
  fieldInit(g, 64, true);
  press(g, "`;.,/ ");
  CHECK(std::string(g.text) == "`;.,/ ");
}

TEST_CASE("Fn chords navigate and never type") {
  TextField f;
  fieldInit(f, 64, false, "abc");
  CHECK(press(f, ",", 1000, true) == FieldAction::kChanged);
  CHECK(f.cursor == 2);
  press(f, ",", 1000, true);
  press(f, ",", 1000, true);
  press(f, ",", 1000, true);  // clamps at 0
  CHECK(f.cursor == 0);
  press(f, "X");
  CHECK(std::string(f.text) == "Xabc");
  press(f, "/", 1000, true);
  CHECK(f.cursor == 2);
  CHECK(press(f, "q", 1000, true) == FieldAction::kNone);
  CHECK(std::string(f.text) == "Xabc");
  CHECK(press(f, "`", 1000, true) == FieldAction::kCancel);
}

TEST_CASE("Enter submits, Del erases before the cursor") {
  TextField f;
  fieldInit(f, 64, false, "abc");
  CHECK(special(f, false, true, false) == FieldAction::kChanged);
  CHECK(std::string(f.text) == "ab");
  press(f, ",", 1000, true);
  special(f, false, true, false);
  CHECK(std::string(f.text) == "b");
  CHECK(f.cursor == 0);
  CHECK(special(f, false, true, false) == FieldAction::kNone);  // nothing before the cursor
  CHECK(special(f, true, false, false) == FieldAction::kSubmit);
}

TEST_CASE("the length cap holds") {
  TextField f;
  fieldInit(f, 8, false);
  press(f, "12345678");
  CHECK(press(f, "9") == FieldAction::kNone);
  CHECK(f.length == 8);
}

TEST_CASE("a port field takes digits only") {
  TextField f;
  fieldInit(f, 5, false);
  f.digitsOnly = true;
  press(f, "7a4:4-4");
  CHECK(std::string(f.text) == "7444");
}

TEST_CASE("only newly pressed keys count") {
  char out[8];
  // 'a' held, then 'b' pressed too: only 'b' is new.
  CHECK(fieldNewlyPressed("a", 1, "ab", 2, out, sizeof(out)) == 1);
  CHECK(out[0] == 'b');
  // A release (nothing new).
  CHECK(fieldNewlyPressed("ab", 2, "a", 1, out, sizeof(out)) == 0);
  // Two keys at once from nothing.
  CHECK(fieldNewlyPressed("", 0, "xy", 2, out, sizeof(out)) == 2);
}

TEST_CASE("masked: the last typed character shows for a second, then a star") {
  TextField f;
  fieldInit(f, 64, true);
  press(f, "p", 1000);
  press(f, "w", 1100);
  CHECK(render(f, 1500) == "*w");
  CHECK(render(f, 1100 + kRevealMs) == "**");
  CHECK(special(f, false, false, true) == FieldAction::kChanged);  // Tab shows
  CHECK(render(f, 5000) == "pw");
  special(f, false, false, true);
  CHECK(render(f, 5000) == "**");
}

TEST_CASE("Tab does nothing on a plain field") {
  TextField f;
  fieldInit(f, 32, false, "Home");
  CHECK(special(f, false, false, true) == FieldAction::kNone);
}

TEST_CASE("the view scrolls to keep the cursor visible") {
  TextField f;
  fieldInit(f, 64, false, "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH");
  size_t cursor = 99;
  const std::string view = render(f, 0, 10, &cursor);
  CHECK(view == "9ABCDEFGH");  // the last 9 characters, and the 10th column for the cursor
  CHECK(cursor == 9);
  for (int i = 0; i < 44; ++i) press(f, ",", 0, true);
  CHECK(render(f, 0, 10, &cursor) == "abcdefghij");
  CHECK(cursor == 0);
}

TEST_CASE("Del repeats after 400 ms, then every 60 ms") {
  CHECK_FALSE(fieldRepeatDue(1399, 1000, 0));
  CHECK(fieldRepeatDue(1400, 1000, 0));
  CHECK_FALSE(fieldRepeatDue(1459, 1000, 1400));
  CHECK(fieldRepeatDue(1460, 1000, 1400));
}
