// Bob Cardputer v2 — which rows of a picker list are on screen (#728).
// Pure and header-only so the host tests build it without M5Unified.
#pragma once

#include <cstddef>

namespace bob {

// A picker list may hold more rows than fit on screen; it scrolls. The
// longest list is Settings' Choose Wi-Fi: 12 scanned networks plus
// "+ Type a network name", "? My network isn't listed" and "Scan again".
constexpr size_t kMaxPickerEntries = 16;

// First row shown for a selection: stays at 0 while the selection is within
// the first screenful, otherwise scrolls so the selection is the last visible
// row. The selected row is always on screen.
inline size_t pickerWindowTop(size_t count, size_t selection, size_t capacity) {
  const size_t top = capacity > 0 && selection >= capacity ? selection - capacity + 1 : 0;
  return top + capacity > count ? count > capacity ? count - capacity : 0 : top;
}

}  // namespace bob
