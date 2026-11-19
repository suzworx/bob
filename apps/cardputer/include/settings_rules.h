// Bob Cardputer v2 — validation for on-device settings (#675; pure, host-tested).
// One place decides what a Wi-Fi name, password, server host or port may be, so
// the store, the Settings screens and the HIL console agree.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

namespace bob {

constexpr size_t kSsidMaxBytes = 32;       // 802.11 SSID limit.
constexpr size_t kPassMaxBytes = 64;       // 63-char passphrase or 64-hex PSK.
constexpr size_t kPassMinPassphrase = 8;   // WPA2-PSK minimum.
constexpr size_t kHostMaxBytes = 63;

// 1..32 bytes; any byte but NUL (SSIDs are raw bytes, not always ASCII).
inline bool ssidValid(const char* ssid) {
  if (!ssid) return false;
  const size_t len = strnlen(ssid, kSsidMaxBytes + 1);
  return len >= 1 && len <= kSsidMaxBytes;
}

inline bool isHexChar(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

// Empty (open network), 8..63 printable ASCII, or exactly 64 hex digits.
inline bool passValid(const char* pass) {
  if (!pass) return false;
  const size_t len = strnlen(pass, kPassMaxBytes + 1);
  if (len == 0) return true;
  if (len == kPassMaxBytes) {
    for (size_t i = 0; i < len; ++i) {
      if (!isHexChar(pass[i])) return false;
    }
    return true;
  }
  if (len < kPassMinPassphrase || len > kPassMaxBytes - 1) return false;
  for (size_t i = 0; i < len; ++i) {
    if (pass[i] < 0x20 || pass[i] > 0x7e) return false;
  }
  return true;
}

// An RFC 1123 host name or a dotted IPv4 address: labels of letters, digits and
// hyphens, 1..63 each, not starting or ending with a hyphen. No scheme, port,
// path or spaces.
inline bool hostValid(const char* host) {
  if (!host) return false;
  const size_t len = strnlen(host, kHostMaxBytes + 1);
  if (len == 0 || len > kHostMaxBytes) return false;
  size_t labelLen = 0;
  char prev = '.';
  for (size_t i = 0; i < len; ++i) {
    const char c = host[i];
    if (c == '.') {
      if (labelLen == 0 || prev == '-') return false;
      labelLen = 0;
    } else {
      const bool alnum = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
      if (!alnum && c != '-') return false;
      if (c == '-' && labelLen == 0) return false;
      ++labelLen;
    }
    prev = c;
  }
  return labelLen > 0 && prev != '-';
}

inline bool portValid(uint32_t port) { return port >= 1 && port <= 65535; }

// Settings closes after 2 minutes without a key press (#677); the guided
// first-boot Setup never does. Compared signed, like persistDue(): an input
// stamped later than `nowMs` is not ~49 days old.
constexpr uint32_t kSettingsIdleCloseMs = 120000;
inline bool settingsIdleClose(uint32_t nowMs, uint32_t lastInputMs, bool setup) {
  return !setup && static_cast<int32_t>(nowMs - lastInputMs) >= static_cast<int32_t>(kSettingsIdleCloseMs);
}

// A ringing timer closes Settings through its normal close path and rings
// (#669, owner 2026-09-30); every other announcement waits until Settings
// closes. The guided Setup is never interrupted, and neither is a scan or a
// join test in flight (closing mid-join would leave the radio on the test
// network): the ring is held and rings as soon as Settings closes.
inline bool settingsYieldsToAnnouncement(bool ring, bool setup, bool radioBusy) {
  return ring && !setup && !radioBusy;
}

}  // namespace bob
