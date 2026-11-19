// Host shim: the subset of the arduino-esp32 core `String` (cores/esp32/
// WString.cpp) that src/protocol.cpp uses. It mirrors the core's edge-case
// behaviour on purpose -- out-of-range operator[] returns 0, indexOf() with
// fromIndex >= length() returns -1, substring() swaps and clamps, and
// startsWith() keeps the core's unsigned `len() - s2.len()` bound -- so a
// parser that only works because of a shim nicety cannot pass here and then
// fail on the device. Storage is std::string so ASan sees every byte.
#pragma once

#include <cstdlib>
#include <cstring>
#include <string>

class String {
 public:
  String() = default;
  String(const char* text) : value_(text ? text : "") {}  // NOLINT: implicit, as in the core.
  String(const std::string& text) : value_(text) {}
  explicit String(char c) : value_(1, c) {}
  explicit String(int value) : value_(std::to_string(value)) {}
  explicit String(unsigned int value) : value_(std::to_string(value)) {}
  explicit String(long value) : value_(std::to_string(value)) {}
  explicit String(unsigned long value) : value_(std::to_string(value)) {}

  unsigned int length() const { return static_cast<unsigned int>(value_.size()); }
  const char* c_str() const { return value_.c_str(); }

  char operator[](unsigned int index) const {
    if (index >= length()) return 0;
    return value_[index];
  }

  int indexOf(char ch, unsigned int fromIndex = 0) const {
    if (fromIndex >= length()) return -1;
    const char* found = strchr(c_str() + fromIndex, ch);
    return found ? static_cast<int>(found - c_str()) : -1;
  }

  int indexOf(const String& needle, unsigned int fromIndex = 0) const {
    if (fromIndex >= length()) return -1;
    const char* found = strstr(c_str() + fromIndex, needle.c_str());
    return found ? static_cast<int>(found - c_str()) : -1;
  }

  bool startsWith(const String& prefix) const {
    if (length() < prefix.length()) return false;
    return startsWith(prefix, 0);
  }

  bool startsWith(const String& prefix, unsigned int offset) const {
    if (offset > static_cast<unsigned int>(length() - prefix.length())) return false;
    return strncmp(c_str() + offset, prefix.c_str(), prefix.length()) == 0;
  }

  String substring(unsigned int left) const { return substring(left, length()); }

  String substring(unsigned int left, unsigned int right) const {
    if (left > right) {
      const unsigned int temp = right;
      right = left;
      left = temp;
    }
    if (left >= length()) return String();
    if (right > length()) right = length();
    return String(value_.substr(left, right - left));
  }

  long toInt() const { return atol(c_str()); }

  bool operator==(const String& other) const { return value_ == other.value_; }
  bool operator==(const char* other) const { return other && value_ == other; }
  bool operator!=(const String& other) const { return !(*this == other); }

  String& operator+=(const String& other) {
    value_ += other.value_;
    return *this;
  }
  String& operator+=(const char* other) {
    if (other) value_ += other;
    return *this;
  }

  friend String operator+(const String& left, const String& right) {
    return String(left.value_ + right.value_);
  }
  friend String operator+(const String& left, const char* right) {
    return String(left.value_ + (right ? right : ""));
  }

 private:
  std::string value_;
};
