// Waveshare ESP32-S3-Touch-LCD-1.85C bring-up: one `ws185 ...` serial line per check, then
// Bob animating on the round screen. No audio is ever dumped, only an rms number.
#include <Arduino.h>
#include <M5Unified.h>

#include "bob_art.h"
#include "bob_emotions.h"
#include "bob_motion.h"
#include "ws185_hw.h"

namespace ws = bob::ws185;

namespace
{
constexpr int16_t kViewW = 360, kViewH = 360; // native round UI: the whole glass
constexpr size_t kMicSamples = 16000;         // 1 s at 16 kHz
constexpr uint32_t kPoseMs = 3000;            // each emotion in the gallery

int16_t s_micBuf[kMicSamples];
uint32_t s_poseAt = 0;
uint8_t s_pose = 0;
bool s_bootWas = false;
bool s_touchWas = false;

// rms of one 1 s window, or -1 if the capture did not run. The first 250 ms (codec warm-up)
// are skipped and the rms is taken around the mean, so a DC offset does not read as sound.
long micRms()
{
  if (!M5.Mic.begin()) { return -1; }
  bool ok = M5.Mic.record(s_micBuf, kMicSamples, 16000);
  uint32_t t0 = millis();
  while (ok && M5.Mic.isRecording() && millis() - t0 < 3000) { delay(5); }
  M5.Mic.end();
  if (!ok) { return -1; }
  constexpr size_t kSkip = 4000;
  double sum = 0, acc = 0;
  for (size_t i = kSkip; i < kMicSamples; i++) { sum += s_micBuf[i]; }
  const double mean = sum / (kMicSamples - kSkip);
  for (size_t i = kSkip; i < kMicSamples; i++) { acc += (s_micBuf[i] - mean) * (s_micBuf[i] - mean); }
  return long(sqrt(acc / (kMicSamples - kSkip)));
}

// Switches Bob to emotion `index` and prints the name in ivory (#FFFDF6) below him.
void showEmotion(uint8_t index)
{
  auto& d = M5.Display;
  const auto e = static_cast<bob::BobEmotion>(index);
  bob::bobMotionSetEmotion(e, 180, 160);
  d.fillRect(60, 280, 240, 40, bob::kBobGround);
  d.setTextColor(d.color565(0xFF, 0xFD, 0xF6), bob::kBobGround);
  d.setTextDatum(middle_center);
  d.setTextSize(3);
  d.drawString(bob::bobEmotionSpec(e).name, kViewW / 2, 296);
  s_poseAt = millis();
}

// One line per emotion with the compose + push time measured over its 3 s.
void printMotionStats()
{
  const auto st = bob::bobMotionTakeStats();
  if (st.frames == 0 || st.windowMs == 0) { return; }
  Serial.printf("ws185 emotion=%s frame_ms=%.1f/%.1f\n", bob::bobEmotionSpec(static_cast<bob::BobEmotion>(s_pose)).name,
                st.totalUs / 1000.0f / st.frames, st.maxUs / 1000.0f);
}
} // namespace

void setup()
{
  auto cfg = M5.config();
  cfg.clear_display = false;
  cfg.internal_spk = false;
  cfg.internal_mic = false;
  cfg.output_power = false;
  M5.begin(cfg);
  Serial.begin(115200);
  delay(1500);

  bool bus = ws::beginBus();
  Serial.printf("ws185 bus=%s tca=%s\n", bus ? "ok" : "fail", bus ? "ok" : "fail");
  bool disp = ws::attachDisplay(kViewW, kViewH);
  Serial.printf("ws185 display=%s w=%d h=%d\n", disp ? "ok" : "fail", int(M5.Display.width()), int(M5.Display.height()));
  M5.Display.fillScreen(bob::kBobGround);
  bool audio = ws::beginAudio();
  Serial.printf("ws185 codec=%s es8311_id=0x%02x es7210_r0=0x%02x\n", audio ? "ok" : "fail", ws::es8311Id(), ws::es7210Reg0());

  bool spk = M5.Speaker.begin();
  if (spk)
  {
    ws::ampEnable(true);
    M5.Speaker.setVolume(200);
    M5.Speaker.tone(1000, 500);
    delay(700);
  }
  Serial.printf("ws185 speaker=%s tone=1000Hz/500ms rate=16000\n", spk ? "ok" : "fail");
  M5.Speaker.end();
  ws::ampEnable(false);

  long quiet = micRms();
  Serial.printf("ws185 mic=%s rms=%ld window=quiet rate=16000\n", quiet >= 0 ? "ok" : "fail", quiet);
  delay(1500);
  long tap = micRms();
  Serial.printf("ws185 mic=%s rms=%ld window=later rate=16000\n", tap >= 0 ? "ok" : "fail", tap);

  const bool motion = bob::bobMotionBegin();
  Serial.printf("ws185 motion sprites=%s psram_free=%u\n", motion ? "ok" : "fail", unsigned(ESP.getFreePsram()));
  showEmotion(0);
}

void loop()
{
  int16_t x, y;
  bool touching = ws::touchPoint(&x, &y);
  int step = 0; // gallery: tap = next, BOOT = previous, otherwise next every 3 s
  if (touching && !s_touchWas) { Serial.printf("ws185 touch x=%d y=%d\n", x, y); step = 1; }
  s_touchWas = touching;
  bool boot = ws::bootPressed();
  if (boot != s_bootWas) { Serial.println(boot ? "ws185 boot=pressed" : "ws185 boot=released"); }
  if (boot && !s_bootWas) { step = -1; }
  s_bootWas = boot;
  if (step == 0 && millis() - s_poseAt >= kPoseMs) { step = 1; }

  if (step != 0)
  {
    printMotionStats();
    s_pose = (s_pose + bob::kBobEmotionCount + step) % bob::kBobEmotionCount;
    showEmotion(s_pose);
  }
  bob::bobMotionTick(millis());
}
