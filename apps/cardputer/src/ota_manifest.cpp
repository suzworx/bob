#include "ota_manifest.h"

#include <cstring>

#include "ota_policy.h"

namespace bob {
namespace {

struct Cursor {
  const char* s;
  size_t n;
  size_t i;
};

void skipWs(Cursor& c) {
  while (c.i < c.n && (c.s[c.i] == ' ' || c.s[c.i] == '\t' || c.s[c.i] == '\n' || c.s[c.i] == '\r')) ++c.i;
}

bool eat(Cursor& c, char ch) {
  skipWs(c);
  if (c.i < c.n && c.s[c.i] == ch) {
    ++c.i;
    return true;
  }
  return false;
}

// Reads a JSON string into `out` (escapes as protocol.cpp's copyJsonString). A
// string longer than outSize-1 fails unless `truncate`; out may be null with outSize 0.
bool readString(Cursor& c, char* out, size_t outSize, bool truncate) {
  if (!eat(c, '"')) return false;
  size_t k = 0;
  while (c.i < c.n) {
    char ch = c.s[c.i++];
    if (ch == '"') {
      if (out != nullptr) out[k] = '\0';
      return true;
    }
    if (ch == '\\') {
      if (c.i >= c.n) return false;
      const char e = c.s[c.i++];
      if (e == 'u') {
        if (c.n - c.i < 4) return false;
        c.i += 4;
        ch = '?';
      } else {
        ch = (e == '"' || e == '\\' || e == '/') ? e : ' ';
      }
    }
    if (k + 1 < outSize) {
      out[k++] = ch;
    } else if (!truncate) {
      return false;
    }
  }
  return false;
}

bool readUint(Cursor& c, uint32_t* out) {
  skipWs(c);
  size_t digits = 0;
  uint32_t n = 0;
  for (; c.i < c.n && c.s[c.i] >= '0' && c.s[c.i] <= '9'; ++c.i, ++digits) {
    if (digits >= 9) return false;
    n = n * 10 + static_cast<uint32_t>(c.s[c.i] - '0');
  }
  *out = n;
  return digits > 0;
}

bool readBool(Cursor& c, bool* out) {
  skipWs(c);
  const size_t left = c.n - c.i;
  if (left >= 4 && strncmp(c.s + c.i, "true", 4) == 0) {
    *out = true;
    c.i += 4;
    return true;
  }
  if (left >= 5 && strncmp(c.s + c.i, "false", 5) == 0) {
    *out = false;
    c.i += 5;
    return true;
  }
  return false;
}

template <typename Fn>
bool eachItem(Cursor& c, char open, char close, Fn fn) {
  if (!eat(c, open)) return false;
  if (eat(c, close)) return true;
  do {
    if (!fn()) return false;
  } while (eat(c, ','));
  return eat(c, close);
}

// Calls fn(key) with the cursor on each member's value. Keys over 23 bytes are
// cut, which cannot alias a contract key (the longest is 19).
template <typename Fn>
bool eachMember(Cursor& c, Fn fn) {
  return eachItem(c, '{', '}', [&] {
    char key[24];
    return readString(c, key, sizeof(key), true) && eat(c, ':') && fn(key);
  });
}

bool skipValue(Cursor& c, int depth) {
  skipWs(c);
  if (c.i >= c.n || depth > 8) return false;
  const char ch = c.s[c.i];
  if (ch == '"') return readString(c, nullptr, 0, true);
  if (ch == '[') return eachItem(c, '[', ']', [&] { return skipValue(c, depth + 1); });
  if (ch == '{') return eachMember(c, [&](const char*) { return skipValue(c, depth + 1); });
  const size_t start = c.i;
  while (c.i < c.n && strchr(",}] \t\r\n", c.s[c.i]) == nullptr) ++c.i;
  return c.i > start;
}

bool parseImage(Cursor& c, OtaManifest& m) {
  uint32_t seen = 0;
  const bool ok = eachMember(c, [&](const char* key) {
    if (strcmp(key, "file") == 0) return (seen |= 1, readString(c, m.imageFile, sizeof(m.imageFile), false));
    if (strcmp(key, "size") == 0) return (seen |= 2, readUint(c, &m.imageSize));
    if (strcmp(key, "sha256") == 0) return (seen |= 4, readString(c, m.sha256, sizeof(m.sha256), false));
    return skipValue(c, 2);
  });
  return ok && seen == 7;
}

bool parseBoards(Cursor& c, OtaManifest& m) {
  m.boardCount = 0;
  return eachItem(c, '[', ']', [&] {
    if (m.boardCount >= kOtaMaxBoards) return false;
    return readString(c, m.boards[m.boardCount++], sizeof(m.boards[0]), false);
  });
}

bool isHex64(const char* s) {
  size_t n = 0;
  for (; (s[n] >= '0' && s[n] <= '9') || (s[n] >= 'a' && s[n] <= 'f') || (s[n] >= 'A' && s[n] <= 'F'); ++n) {
  }
  return n == 64 && s[n] == '\0';
}

}  // namespace

bool parseOtaManifest(const char* json, size_t len, OtaManifest* out) {
  if (json == nullptr || out == nullptr) return false;
  *out = OtaManifest();
  OtaManifest& m = *out;
  Cursor c{json, len, 0};
  uint32_t seen = 0;
  uint32_t bit = 0;
  auto str = [&](char* dst, size_t size, bool cut = false) { seen |= 1u << bit; return readString(c, dst, size, cut); };
  auto num = [&](uint32_t* dst) { seen |= 1u << bit; return readUint(c, dst); };
  auto nullOr = [&](char* dst, size_t size) {
    seen |= 1u << bit;
    skipWs(c);
    if (c.n - c.i >= 4 && strncmp(c.s + c.i, "null", 4) == 0) {
      c.i += 4;
      return true;
    }
    return readString(c, dst, size, false);
  };
  auto flag = [&](bool* dst) { seen |= 1u << bit; return readBool(c, dst); };
  static const char* const kKeys[] = {"schema", "product", "version", "boards", "image", "min_from",
                                      "allow_downgrade", "rollback_safe", "settings_schema",
                                      "requires_bootloader", "mandatory", "security_fix", "key_id",
                                      "git_sha", "built_at", "notes"};
  const bool ok = eachMember(c, [&](const char* key) {
    bit = 0;
    while (bit < sizeof(kKeys) / sizeof(kKeys[0]) && strcmp(key, kKeys[bit]) != 0) ++bit;
    switch (bit) {
      case 0: return num(&m.schema);
      case 1: return str(m.product, sizeof(m.product));
      case 2: return str(m.version, sizeof(m.version));
      case 3: return (seen |= 1u << bit, parseBoards(c, m));
      case 4: return (seen |= 1u << bit, parseImage(c, m));
      case 5: return str(m.minFrom, sizeof(m.minFrom));
      case 6: return flag(&m.allowDowngrade);
      case 7: return flag(&m.rollbackSafe);
      case 8: return num(&m.settingsSchema);
      case 9: return nullOr(m.requiresBootloader, sizeof(m.requiresBootloader));
      case 10: return flag(&m.mandatory);
      case 11: return flag(&m.securityFix);
      case 12: return str(m.keyId, sizeof(m.keyId));
      case 13: return str(m.gitSha, sizeof(m.gitSha));
      case 14: return str(m.builtAt, sizeof(m.builtAt));
      case 15: return str(m.notes, sizeof(m.notes), true);
      default: return skipValue(c, 1);
    }
  });
  skipWs(c);
  return ok && c.i == c.n && seen == 0xFFFFu && isHex64(m.sha256);
}

OtaManifestReason otaManifestAcceptable(const OtaManifest& m, const char* runningVersion,
                                        const char* boardId, uint32_t slotSize) {
  if (m.schema != 1) return OtaManifestReason::BadSchema;
  if (strcmp(m.product, "bob-cardputer") != 0) return OtaManifestReason::BadProduct;
  bool boardOk = false;
  for (uint8_t i = 0; boardId != nullptr && i < m.boardCount; ++i) boardOk = boardOk || strcmp(m.boards[i], boardId) == 0;
  if (!boardOk) return OtaManifestReason::BadBoard;
  if (m.imageSize == 0 || m.imageSize > slotSize) return OtaManifestReason::TooBig;
  const OtaVersion candidate = otaParseVersion(m.version);
  const OtaVersion running = otaParseVersion(runningVersion);
  if (!candidate.valid || !running.valid) return OtaManifestReason::NotNewer;
  if (!m.allowDowngrade && otaCompareVersion(candidate, running) <= 0) return OtaManifestReason::NotNewer;
  if (m.minFrom[0] != '\0') {
    const OtaVersion minFrom = otaParseVersion(m.minFrom);
    if (!minFrom.valid || otaCompareVersion(running, minFrom) < 0) return OtaManifestReason::BelowMinFrom;
  }
  return OtaManifestReason::Ok;
}

}  // namespace bob
