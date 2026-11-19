// Which picker rows are on screen (include/picker_window.h, #728): the
// selected row is always visible, however long the list.
#include <cstddef>

#include "doctest.h"
#include "picker_window.h"

using namespace bob;

namespace {
constexpr size_t kCapacity = 5;  // display.cpp: (110 - 2 - 40) / 12

bool visible(size_t count, size_t selection) {
  const size_t top = pickerWindowTop(count, selection, kCapacity);
  return selection >= top && selection < top + kCapacity && top + kCapacity <= (count > kCapacity ? count : kCapacity);
}
}  // namespace

TEST_CASE("a short list never scrolls") {
  for (size_t s = 0; s < 4; ++s) CHECK(pickerWindowTop(4, s, kCapacity) == 0);
  CHECK(pickerWindowTop(0, 0, kCapacity) == 0);
}

TEST_CASE("the first screenful stays put, then the selection is the last row") {
  CHECK(pickerWindowTop(15, 4, kCapacity) == 0);
  CHECK(pickerWindowTop(15, 5, kCapacity) == 1);
  CHECK(pickerWindowTop(15, 14, kCapacity) == 10);
}

TEST_CASE("Choose Wi-Fi with 12 networks: every row, including the 3 options, can be shown") {
  const size_t rows = 12 + 3;
  REQUIRE(rows <= kMaxPickerEntries);
  for (size_t s = 0; s < rows; ++s) CHECK(visible(rows, s));
}

TEST_CASE("every list length up to the cap keeps the selection on screen") {
  for (size_t count = 1; count <= kMaxPickerEntries; ++count) {
    for (size_t s = 0; s < count; ++s) CHECK(visible(count, s));
  }
}
