// Visual-gate driver for bob-sim (tools/visual-gate): the bob-sim CLI with every state the flash gate
// compares. candidate.mjs builds it in place of tools/bob-sim/src/main.cpp of the firmware checkout under test,
// so older and newer firmware render through the same driver.
//   bob-sim --state <demo screen> [--emotion <name>] [--move <name>] [--frames N] --out <dir>
//   bob-sim ... --freeze               REST mode: Bob in the rest pose of the state and emotion (bobMotionFreeze)
//   bob-sim ... --move <m> --pose-t T  the move's key pose at normalised time T (bobMotionPoseAt; implies freeze)
//   bob-sim --info   prints rig=1|0 and freeze=1|0: the variant compiled in, and whether the firmware has the
//                    BOBSIM_FREEZE hooks (freeze=0 means only the gate's weak fallbacks below were linked)
// The firmware's own demoScreen() draws the scene (as `T ui <name>` does on the device); a fake clock steps
// 33 ms per frame, so two runs with the same arguments write identical bytes.
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>

#include "bob_motion.h"
#include "chrome.h"
#include "round_ui.h"
#include "stb_image_write.h"

namespace bob
{
namespace fsm
{
extern State state;
}
namespace roundui
{
bool demoScreen(const char* name);
}
// The REST-mode hooks (bob_motion.h under -DBOBSIM_FREEZE=1). Declared here as well, so a checkout without them still
// links against the weak fallbacks in gate_stubs.cpp, which report freeze=0 through gateFreezeMissing.
void bobMotionFreeze(bool on);
bool bobMotionPoseAt(const char* move, float t);
extern bool gateFreezeMissing;
} // namespace bob

using namespace bob;

namespace
{
struct Scene
{
  const char* name;
  State state;
};
constexpr Scene kScenes[] = {
    {"ready", State::kReady},       {"listening", State::kCapturing}, {"thinking", State::kAwaiting},
    {"speaking", State::kAwaiting}, {"pairing", State::kPairing},     {"reply", State::kAwaiting},
    {"error", State::kError},       {"offline", State::kWifi},        {"updating", State::kUpdating},
};
constexpr uint32_t kStepMs = 33; // one present() interval
constexpr int kSize = 360;

bool sameName(const char* a, const char* b)
{
  for (; *a != '\0' && *b != '\0'; ++a, ++b)
  {
    if (std::tolower(static_cast<unsigned char>(*a)) != std::tolower(static_cast<unsigned char>(*b))) { return false; }
  }
  return *a == *b;
}

// The panel stand-in as RGB888: 16-bit sprite, big-endian RGB565 in memory, bits replicated.
void readRgb(unsigned char* rgb)
{
  const auto* px = static_cast<const uint8_t*>(M5.Display.getBuffer());
  for (int i = 0; i < kSize * kSize; ++i)
  {
    const unsigned v = (static_cast<unsigned>(px[2 * i]) << 8) | px[2 * i + 1];
    const unsigned r = v >> 11, g = (v >> 5) & 63, b = v & 31;
    rgb[3 * i] = static_cast<unsigned char>((r << 3) | (r >> 2));
    rgb[3 * i + 1] = static_cast<unsigned char>((g << 2) | (g >> 4));
    rgb[3 * i + 2] = static_cast<unsigned char>((b << 3) | (b >> 2));
  }
}

bool writePng(const std::string& path)
{
  static unsigned char rgb[kSize * kSize * 3];
  readRgb(rgb);
  return stbi_write_png(path.c_str(), kSize, kSize, 3, rgb, kSize * 3) != 0;
}

int usage()
{
  std::fprintf(stderr,
               "usage: bob-sim --state ready|listening|thinking|speaking|pairing|reply|error|offline|updating "
               "[--emotion <name>] [--move <name> [--pose-t T]] [--freeze] [--frames N] [--all-frames] --out <dir>\n");
  return 2;
}
} // namespace

int main(int argc, char** argv)
{
  const char* sceneName = "ready";
  const char* emotionName = nullptr;
  const char* outDir = ".";
  int frames = 1;
  bool allFrames = false, tap = false;
  const char* moveName = nullptr;
  bool freeze = false;
  float poseT = -1.0f;
  for (int i = 1; i < argc; ++i)
  {
    const bool more = i + 1 < argc;
    if (!std::strcmp(argv[i], "--state") && more) { sceneName = argv[++i]; }
    else if (!std::strcmp(argv[i], "--emotion") && more) { emotionName = argv[++i]; }
    else if (!std::strcmp(argv[i], "--frames") && more) { frames = std::atoi(argv[++i]); }
    else if (!std::strcmp(argv[i], "--out") && more) { outDir = argv[++i]; }
    else if (!std::strcmp(argv[i], "--all-frames")) { allFrames = true; }
    else if (!std::strcmp(argv[i], "--move") && more) { moveName = argv[++i]; }
    else if (!std::strcmp(argv[i], "--tap")) { tap = true; }
    else if (!std::strcmp(argv[i], "--freeze")) { freeze = true; }
    else if (!std::strcmp(argv[i], "--pose-t") && more) { poseT = static_cast<float>(std::atof(argv[++i])); }
    else if (!std::strcmp(argv[i], "--info"))
    {
      // What this binary was compiled as, so the gate can refuse a variant it did not ask for.
#if defined(BOB_RIG)
      std::printf("rig=1\n");
#else
      std::printf("rig=0\n");
#endif
      bobMotionFreeze(false);
      std::printf("freeze=%d\n", gateFreezeMissing ? 0 : 1);
      return 0;
    }
    else { return usage(); }
  }
  if (frames < 1) { return usage(); }

  const Scene* scene = nullptr;
  for (const Scene& s : kScenes)
  {
    if (sameName(s.name, sceneName)) { scene = &s; }
  }
  if (scene == nullptr) { std::fprintf(stderr, "unknown state '%s'\n", sceneName); return usage(); }

  BobEmotion emotion = BobEmotion::kCount;
  if (emotionName != nullptr)
  {
    for (uint8_t e = 0; e < kBobEmotionCount; ++e)
    {
      if (sameName(kBobEmotions[e].name, emotionName)) { emotion = static_cast<BobEmotion>(e); }
    }
    if (emotion == BobEmotion::kCount)
    {
      std::fprintf(stderr, "unknown emotion '%s'; known:", emotionName);
      for (uint8_t e = 0; e < kBobEmotionCount; ++e) { std::fprintf(stderr, " %s", kBobEmotions[e].name); }
      std::fprintf(stderr, "\n");
      return 2;
    }
  }

  bobsim::setNowMs(1000);
  M5.Display.setColorDepth(16);
  if (M5.Display.createSprite(kSize, kSize) == nullptr) { std::fprintf(stderr, "cannot allocate display\n"); return 1; }
  M5.Display.fillScreen(0);
  fsm::state = scene->state;
  chromeBegin();
  if (!roundui::demoScreen(scene->name)) { std::fprintf(stderr, "demo screen '%s' failed\n", scene->name); return 1; }
  if (emotion != BobEmotion::kCount) { bobMotionSetEmotion(emotion, kRuiBobCx, kRuiBobCy); }

  if (freeze)
  {
    bobMotionFreeze(true);
    // Whether Bob really holds still (the whole-pose path does not honour the freeze) is proven by the gate, which
    // renders every case again at half its time and needs the same bytes.
    if (gateFreezeMissing) { std::fprintf(stderr, "--freeze: the firmware has no BOBSIM_FREEZE hooks\n"); return 2; }
  }
  if (moveName != nullptr && poseT >= 0.0f)
  {
    if (!bobMotionPoseAt(moveName, poseT)) { std::fprintf(stderr, "move %s has no key pose (rig off, unknown move, or no BOBSIM_FREEZE hooks)\n", moveName); return 2; }
  }
  else if (moveName != nullptr && !bobMotionPlayMove(moveName)) { std::fprintf(stderr, "move %s not available (rig off or unknown)\n", moveName); return 2; }
  if (tap) { bobMotionTapReaction(); }
  const std::string base = std::string(outDir) + "/" + scene->name + (emotionName ? std::string("-") + kBobEmotions[static_cast<uint8_t>(emotion)].name : "");
  std::filesystem::create_directories(outDir);
  for (int f = 0; f < frames; ++f)
  {
    bobsim::setNowMs(1000 + kStepMs * static_cast<uint32_t>(f + 1));
    chromeTick(millis());
    if (allFrames)
    {
      char suffix[16];
      std::snprintf(suffix, sizeof(suffix), "-%03d.png", f);
      if (!writePng(base + suffix)) { return 1; }
    }
  }
  if (!writePng(base + ".png")) { std::fprintf(stderr, "cannot write PNG under %s\n", outDir); return 1; }
  std::printf("%s.png\n", base.c_str());
  return 0;
}
