// Shared helpers for the firmware host tests. Suites run with apps/cardputer
// as the working directory (test/host/run.mjs), so fixtures load by relative
// path from test/fixtures/wire -- the same files apps/api/tests/
// wire-fixtures.test.ts validates against the server's Zod schemas.
#pragma once

#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>

#include <Arduino.h>

namespace hosttest {

// The exact wire bytes of one fixture. Files end in a newline (and CRLF on a
// Windows checkout); the message itself is always one line, so the trailing
// line break is dropped.
inline String fixture(const std::string& name) {
  const std::string path = "test/fixtures/wire/" + name + ".json";
  std::ifstream file(path, std::ios::binary);
  if (!file) throw std::runtime_error("missing fixture " + path);
  std::stringstream buffer;
  buffer << file.rdbuf();
  std::string text = buffer.str();
  while (!text.empty() && (text.back() == '\n' || text.back() == '\r')) text.pop_back();
  return String(text);
}

inline std::string str(const String& value) { return std::string(value.c_str()); }

}  // namespace hosttest
