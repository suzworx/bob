// Speaker loopback self-test rule (include/speaker_test.h, P0 #1063): the tone must reach the mic
// kMinRiseDb above the quiet phase, the DC offset of the ES7210 never counts as sound, and a dead
// mic is told apart from a silent speaker.
#include <cmath>
#include <cstdint>
#include <string>

#include "doctest.h"
#include "speaker_test.h"

using namespace bob::spktest;

TEST_CASE("spktest: AC RMS ignores a DC offset and measures a sine at amplitude / sqrt(2)") {
  AcRms dc;
  for (int i = 0; i < 1000; ++i) dc.add(-1200);
  CHECK(dc.rms() == doctest::Approx(0.0f).epsilon(0.001));
  CHECK(dc.count() == 1000);

  AcRms tone;
  for (uint32_t i = 0; i < 1600; ++i) tone.add(toneSample(i) + 300);  // offset rides along
  CHECK(tone.rms() == doctest::Approx(kToneAmplitude / std::sqrt(2.0f)).epsilon(0.01));

  AcRms none;
  CHECK(none.rms() == doctest::Approx(0.0f));
}

TEST_CASE("spktest: the tone is 1 kHz at 16 kHz, a 16-sample period starting at 0") {
  CHECK(toneSample(0) == 0);
  CHECK(toneSample(4) == kToneAmplitude);
  CHECK(toneSample(12) == -kToneAmplitude);
  CHECK(toneSample(16) == toneSample(0));
  CHECK(toneSample(21) == toneSample(5));
}

TEST_CASE("spktest: a speaker the mic hears passes; a silent one (amp off, DAC muted) fails") {
  Levels heard;
  heard.quietRms = 20.0f;
  heard.ampOffRms = 22.0f;
  heard.toneRms = 900.0f;
  const Verdict ok = judge(heard, 4800);
  CHECK(ok.pass);
  CHECK(std::string(ok.stage) == "ok");
  CHECK(ok.riseDb > 30.0f);
  CHECK(ok.ampOffRiseDb < 3.0f);

  Levels silent;  // the #1063 symptom: the reply plays its length, nothing comes out
  silent.quietRms = 20.0f;
  silent.ampOffRms = 21.0f;
  silent.toneRms = 23.0f;
  const Verdict bad = judge(silent, 4800);
  CHECK_FALSE(bad.pass);
  CHECK(std::string(bad.stage) == "silent");

  Levels edge;  // just under the threshold still fails
  edge.quietRms = 99.0f;
  edge.toneRms = 99.0f * std::pow(10.0f, (kMinRiseDb - 0.5f) / 20.0f);
  CHECK_FALSE(judge(edge, 4800).pass);
  edge.toneRms = 100.0f * std::pow(10.0f, (kMinRiseDb + 0.5f) / 20.0f);
  CHECK(judge(edge, 4800).pass);
}

TEST_CASE("spktest: no mic samples is a mic failure, never a pass, and digital zeros stay finite") {
  Levels zeros;
  const Verdict v = judge(zeros, 0);
  CHECK_FALSE(v.pass);
  CHECK(std::string(v.stage) == "mic");
  CHECK(std::isfinite(v.riseDb));
  CHECK(riseDb(0.0f, 0.0f) == doctest::Approx(0.0f));
}
