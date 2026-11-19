// Visual-gate text probe: draws text the way the device does, for the faithful candidate (faithful.py).
// The firmware's own Nunito VLW fonts (apps/cardputer/lib/fonts/nunito_<role>.vlw), LovyanGFX's smooth-font path and the
// middle_center datum of round_ui.cpp textCentered(). Each job draws one line in white on black on a 360 px RGB565
// sprite (the panel's depth) and writes it as a PNG: its red channel is the device's coverage of that line.
//   gate-text <fonts dir> <jobs file> <out dir>
// A jobs line is: role <TAB> centre x <TAB> centre y <TAB> text   (role: caption, body, title, hero)
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include <LovyanGFX.hpp>

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

namespace
{
constexpr int kSize = 360;

std::vector<uint8_t> readFile(const std::string& path)
{
  std::ifstream f(path, std::ios::binary);
  return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

bool writePng(lgfx::LGFX_Sprite& s, const std::string& path)
{
  static unsigned char rgb[kSize * kSize * 3];
  const auto* px = static_cast<const uint8_t*>(s.getBuffer());
  for (int i = 0; i < kSize * kSize; ++i)
  {
    const unsigned v = (static_cast<unsigned>(px[2 * i]) << 8) | px[2 * i + 1];
    const unsigned r = v >> 11, g = (v >> 5) & 63, b = v & 31;
    rgb[3 * i] = static_cast<unsigned char>((r << 3) | (r >> 2));
    rgb[3 * i + 1] = static_cast<unsigned char>((g << 2) | (g >> 4));
    rgb[3 * i + 2] = static_cast<unsigned char>((b << 3) | (b >> 2));
  }
  return stbi_write_png(path.c_str(), kSize, kSize, 3, rgb, kSize * 3) != 0;
}
} // namespace

int main(int argc, char** argv)
{
  if (argc != 4) { std::fprintf(stderr, "usage: gate-text <fonts dir> <jobs file> <out dir>\n"); return 2; }
  const std::string fonts = argv[1], out = argv[3];
  std::map<std::string, std::vector<uint8_t>> data;
  std::map<std::string, lgfx::PointerWrapper> wrappers;
  std::map<std::string, lgfx::VLWfont> loaded;
  for (const char* role : {"caption", "body", "title", "hero"})
  {
    data[role] = readFile(fonts + "/nunito_" + role + ".vlw");
    if (data[role].empty()) { std::fprintf(stderr, "missing font %s/nunito_%s.vlw\n", fonts.c_str(), role); return 1; }
    wrappers[role].set(data[role].data(), data[role].size());
    if (!loaded[role].loadFont(&wrappers[role])) { std::fprintf(stderr, "cannot load font %s\n", role); return 1; }
  }

  lgfx::LGFX_Sprite s;
  s.setColorDepth(16);
  if (s.createSprite(kSize, kSize) == nullptr) { std::fprintf(stderr, "cannot allocate sprite\n"); return 1; }
  std::ifstream jobs(argv[2]);
  std::string line;
  int n = 0;
  while (std::getline(jobs, line))
  {
    if (line.empty()) { continue; }
    std::istringstream f(line);
    std::string role, x, y, text;
    std::getline(f, role, '\t');
    std::getline(f, x, '\t');
    std::getline(f, y, '\t');
    std::getline(f, text);
    if (loaded.find(role) == loaded.end()) { std::fprintf(stderr, "job %d: unknown role %s\n", n, role.c_str()); return 1; }
    s.fillScreen(0);
    s.setFont(&loaded[role]);
    s.setTextDatum(lgfx::v1::textdatum::middle_center);
    s.setTextColor(0xFFFF);
    s.drawString(text.c_str(), std::atoi(x.c_str()), std::atoi(y.c_str()));
    char name[32];
    std::snprintf(name, sizeof(name), "/text-%03d.png", n);
    if (!writePng(s, out + name)) { std::fprintf(stderr, "cannot write %s%s\n", out.c_str(), name); return 1; }
    ++n;
  }
  std::printf("drew %d line(s)\n", n);
  return 0;
}
