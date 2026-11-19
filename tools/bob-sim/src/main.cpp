// bob-sim CLI: renders the Waveshare round UI headless to PNG.
//   bob-sim --state ready|listening|thinking|speaking|pairing|hello|offline|error|updating|sleeping|reply|announce|field [--emotion <name>] [--frames N] --out <dir>
// The firmware's own demoScreen() draws the scene; a fake clock steps 33 ms per frame, so two
// runs with the same arguments write identical bytes.
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
#include <vector>

#include "bob_motion.h"
#include "chrome.h"
#include "round_ui.h"
#include "scene_engine.h"
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
    {"speaking", State::kAwaiting}, {"pairing", State::kPairing},
    {"hello", State::kWifi},        {"offline", State::kError},       {"error", State::kError},
    {"updating", State::kUpdating}, {"sleeping", State::kReady},      {"reply", State::kAwaiting},
    {"announce", State::kAnnounce}, {"field", State::kReady},
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
               "usage: bob-sim --state ready|listening|thinking|speaking|pairing|reply|help|picker|... [--emotion <name>] [--scene <name> [--value N] [--seconds N]] "
               "[--frames N] [--all-frames] --out <dir>\n");
  return 2;
}
} // namespace

extern "C" const uint8_t bob_welcome[];
extern "C" const uint8_t bob_curious[];
extern "C" const uint8_t bob_thoughtful[];
extern "C" const uint8_t bob_playful[];

namespace
{
// Every eye type in all four poses at three gaze positions (left/up extreme, centre, right/down extreme), drawn by the
// firmware's own bobFaceDraw into a pose sprite and cropped around the visor: columns are pose x gaze, rows are the
// BobEyes values in enum order. Eyes must stay inside the visor in every tile (the host test checks it by pixels).
int faceMatrix(const std::string& outDir)
{
  const uint8_t* art[4] = {bob_welcome, bob_curious, bob_thoughtful, bob_playful};
  const float cx[4] = {92, 83, 88, 98}, cy[4] = {50, 50.5f, 47.5f, 50};
  const float gaze[3][2] = {{-3, -1.5f}, {0, 0}, {3, 1.5f}};
  constexpr int kCropW = 84, kCropH = 46, kScale = 2, kPad = 2;
  const int rows = static_cast<int>(BobEyes::kSkeptic) + 1, cols = 12;
  const int tileW = kCropW * kScale + kPad, tileH = kCropH * kScale + kPad;
  const int width = cols * tileW, height = rows * tileH;
  std::vector<unsigned char> rgb(static_cast<size_t>(width) * height * 3, 24);
  M5Canvas sprite;
  sprite.setColorDepth(16);
  if (sprite.createSprite(192, 192) == nullptr) { std::fprintf(stderr, "cannot allocate the pose sprite\n"); return 1; }
  for (int e = 0; e < rows; ++e)
  {
    for (int pose = 0; pose < 4; ++pose)
    {
      for (int g = 0; g < 3; ++g)
      {
        std::memcpy(sprite.getBuffer(), art[pose], 192 * 192 * 2);
        bobFaceDraw(sprite, static_cast<BobPose>(pose), static_cast<BobEyes>(e), 1.0f, 0.0f, 0.0f, gaze[g][0], gaze[g][1]);
        const auto* px = static_cast<const uint8_t*>(sprite.getBuffer());
        const int x0 = static_cast<int>(cx[pose]) - kCropW / 2, y0 = static_cast<int>(cy[pose]) - kCropH / 2;
        const int col = pose * 3 + g;
        for (int y = 0; y < kCropH; ++y)
        {
          for (int x = 0; x < kCropW; ++x)
          {
            const size_t i = 2u * (static_cast<size_t>(y0 + y) * 192 + (x0 + x));
            const unsigned v = (static_cast<unsigned>(px[i]) << 8) | px[i + 1];
            const unsigned r = v >> 11, gg = (v >> 5) & 63, b = v & 31;
            for (int dy = 0; dy < kScale; ++dy)
            {
              for (int dx = 0; dx < kScale; ++dx)
              {
                const size_t o = 3u * (static_cast<size_t>(e * tileH + y * kScale + dy) * width + (col * tileW + x * kScale + dx));
                rgb[o] = static_cast<unsigned char>((r << 3) | (r >> 2));
                rgb[o + 1] = static_cast<unsigned char>((gg << 2) | (gg >> 4));
                rgb[o + 2] = static_cast<unsigned char>((b << 3) | (b >> 2));
              }
            }
          }
        }
      }
    }
  }
  std::filesystem::create_directories(outDir);
  const std::string path = outDir + "/face-matrix.png";
  if (stbi_write_png(path.c_str(), width, height, 3, rgb.data(), width * 3) == 0) { std::fprintf(stderr, "cannot write %s\n", path.c_str()); return 1; }
  std::printf("%s (%d eye types x 4 poses x 3 gaze positions)\n", path.c_str(), rows);
  return 0;
}
} // namespace

int main(int argc, char** argv)
{
  const char* sceneName = "ready";
  const char* emotionName = nullptr;
  const char* outDir = ".";
  int frames = 1;
  bool allFrames = false, matrix = false, hold = false, look = false;
  const char* sceneArg = nullptr;
  int sceneValue = 0, sceneSeconds = 0;
  int tapFrame = -1, lookX = 180, lookY = 140;
  const char* moveName = nullptr;
  for (int i = 1; i < argc; ++i)
  {
    const bool more = i + 1 < argc;
    if (!std::strcmp(argv[i], "--state") && more) { sceneName = argv[++i]; }
    else if (!std::strcmp(argv[i], "--emotion") && more) { emotionName = argv[++i]; }
    else if (!std::strcmp(argv[i], "--frames") && more) { frames = std::atoi(argv[++i]); }
    else if (!std::strcmp(argv[i], "--out") && more) { outDir = argv[++i]; }
    else if (!std::strcmp(argv[i], "--all-frames")) { allFrames = true; }
    else if (!std::strcmp(argv[i], "--face-matrix")) { matrix = true; }
    else if (!std::strcmp(argv[i], "--scene") && more) { sceneArg = argv[++i]; }    // start one of Bob's action scenes
    else if (!std::strcmp(argv[i], "--value") && more) { sceneValue = std::atoi(argv[++i]); }   // the scene's number (a timer's seconds)
    else if (!std::strcmp(argv[i], "--seconds") && more) { sceneSeconds = std::atoi(argv[++i]); }  // 0 = the scene's own default
    else if (!std::strcmp(argv[i], "--hold")) { hold = true; }            // a finger holds Bob from frame 0
    else if (!std::strcmp(argv[i], "--tap") && more) { tapFrame = std::atoi(argv[++i]); }  // tap Bob at frame N
    else if (!std::strcmp(argv[i], "--look") && more) { look = std::sscanf(argv[++i], "%d,%d", &lookX, &lookY) == 2; }  // gaze target
    else if (!std::strcmp(argv[i], "--move") && more) { moveName = argv[++i]; }
    else { return usage(); }
  }
  if (matrix) { return faceMatrix(outDir); }
  if (frames < 1) { return usage(); }

  const Scene* scene = nullptr;
  for (const Scene& s : kScenes)
  {
    if (sameName(s.name, sceneName)) { scene = &s; }
  }
  static const Scene generic{sceneName, State::kReady};  // any other demo screen (reply, help, picker, ...): drawn by demoScreen()
  if (scene == nullptr) { scene = &generic; }

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
  std::string sceneTag;
  if (sceneArg != nullptr)
  {
    const scene::SceneId id = scene::idFromName(sceneArg);
    if (id == scene::SceneId::kNone)
    {
      std::fprintf(stderr, "unknown scene '%s'; known:", sceneArg);
      for (uint8_t i = 1; i < scene::kSceneCount; ++i) { std::fprintf(stderr, " %s", scene::kScenes[i].name); }
      std::fprintf(stderr, "\n");
      return 2;
    }
    if (!sceneBegin(id, scene::durationSeconds(id, static_cast<uint32_t>(sceneSeconds)), "", sceneValue, false, millis()))
    {
      std::fprintf(stderr, "scene '%s' was not started (Bob is not on this screen)\n", sceneArg);
      return 1;
    }
    sceneTag = std::string("-scene-") + sceneArg;
  }

  if (moveName != nullptr && !bobMotionPlayMove(moveName)) { std::fprintf(stderr, "move %s not available (rig off or unknown)\n", moveName); return 2; }
  const std::string base = std::string(outDir) + "/" + scene->name + (emotionName ? std::string("-") + kBobEmotions[static_cast<uint8_t>(emotion)].name : "") + sceneTag;
  std::filesystem::create_directories(outDir);
  for (int f = 0; f < frames; ++f)
  {
    bobsim::setNowMs(1000 + kStepMs * static_cast<uint32_t>(f + 1));
    if (hold) { bobMotionHold(true); }
    if (look) { bobMotionLookAt(static_cast<int16_t>(lookX), static_cast<int16_t>(lookY)); }
    if (f == tapFrame) { bobMotionTapReaction(); }
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
