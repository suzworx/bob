// bob-sim shim: the slice of the Arduino `String` the round UI uses (concatenation, number
// formatting, c_str). std::string storage; behaviour matches the core for these calls only.
#pragma once

#include <cstdio>
#include <cstring>
#include <string>

#ifndef HEX
#define HEX 16
#define DEC 10
#endif

class String
{
public:
  String() = default;
  String(const char* t) : v_(t ? t : "") {}
  String(const std::string& t) : v_(t) {}
  explicit String(char c) : v_(1, c) {}
  explicit String(int n, int base = 10) : v_(fmt(static_cast<long long>(n), base)) {}
  explicit String(unsigned n, int base = 10) : v_(fmtU(n, base)) {}
  explicit String(long n, int base = 10) : v_(fmt(n, base)) {}
  explicit String(unsigned long n, int base = 10) : v_(fmtU(n, base)) {}
  explicit String(long long n, int base = 10) : v_(fmt(n, base)) {}
  explicit String(unsigned long long n, int base = 10) : v_(fmtU(n, base)) {}

  const char* c_str() const { return v_.c_str(); }
  unsigned length() const { return static_cast<unsigned>(v_.size()); }
  String& operator+=(const String& o) { v_ += o.v_; return *this; }
  friend String operator+(String a, const String& b) { a.v_ += b.v_; return a; }
  friend String operator+(String a, const char* b) { a.v_ += b ? b : ""; return a; }
  friend String operator+(String a, char b) { a.v_ += b; return a; }
  friend String operator+(String a, int b) { return a += String(b); }
  friend String operator+(String a, unsigned b) { return a += String(b); }
  friend String operator+(String a, long b) { return a += String(b); }
  friend String operator+(String a, unsigned long b) { return a += String(b); }
  friend String operator+(String a, long long b) { return a += String(b); }
  friend String operator+(String a, unsigned long long b) { return a += String(b); }

private:
  static std::string fmt(long long n, int base)
  {
    if (base == 16) { return fmtU(static_cast<unsigned long long>(n), 16); }
    return std::to_string(n);
  }
  static std::string fmtU(unsigned long long n, int base)
  {
    char b[32];
    std::snprintf(b, sizeof(b), base == 16 ? "%llx" : "%llu", n);
    return b;
  }
  std::string v_;
};
