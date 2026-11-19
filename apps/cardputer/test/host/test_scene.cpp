// Bob's action scenes: the catalogue (libs/bob-device/src/scene_table.h), the `scene` wire message (protocol.cpp) and
// the layer clocks and keyframes (libs/bob-device/src/scene_layers.h).
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>

#include "doctest.h"
#include "protocol.h"
#include "round_ring_policy.h"
#include "scene_layers.h"
#include "scene_table.h"

using namespace bob::scene;

namespace {

std::string readFile(const char* path) {
  std::ifstream in(path);
  std::stringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

bob::SceneMessage parse(const char* json, bool* ok) {
  bob::SceneMessage m;
  *ok = bob::parseScene(String(json), m);
  return m;
}

}  // namespace

TEST_CASE("scene: every scene has a unique wire name, a valid emotion, ring, props and a bounded duration") {
  const std::string emotions = readFile("../../libs/bob-device/src/bob_emotion_table.h");
  REQUIRE(!emotions.empty());
  for (uint8_t i = 1; i < kSceneCount; ++i) {
    const SceneSpec& s = kScenes[i];
    INFO("scene " << s.name);
    REQUIRE(s.name[0] != '\0');
    CHECK(std::strlen(s.name) < 24);
    for (const char* p = s.name; *p; ++p) CHECK(((*p >= 'a' && *p <= 'z') || *p == '_'));
    for (uint8_t j = 1; j < i; ++j) CHECK(std::strcmp(kScenes[j].name, s.name) != 0);
    CHECK(emotions.find(std::string("X(") + s.emotion + ",") != std::string::npos);  // one of the 47
    CHECK(static_cast<uint8_t>(s.ring) <= static_cast<uint8_t>(Ring::kSleep));
    CHECK(static_cast<uint8_t>(s.prop0) < kPropCount);
    CHECK(static_cast<uint8_t>(s.prop1) < kPropCount);
    CHECK(s.seconds >= kMinSeconds);
    CHECK(s.seconds <= kMaxSeconds);
    CHECK(s.icon[0] != '\0');
    CHECK(idFromName(s.name) == static_cast<SceneId>(i));
  }
  CHECK(kSceneCount == 17);  // none + the 16 of the contract
}

TEST_CASE("scene: the contract's names are all there and unknown names map to none") {
  for (const char* n : {"timer_set", "timer_done", "alarm", "weather_sun", "weather_cloud", "weather_rain", "weather_snow", "music",
                        "task_added", "note_added", "reminder", "calendar", "search", "message_sent", "success", "failed"}) {
    INFO(n);
    CHECK(idFromName(n) != SceneId::kNone);
  }
  CHECK(idFromName("confetti_cannon") == SceneId::kNone);
  CHECK(idFromName("") == SceneId::kNone);
  CHECK(idFromName(nullptr) == SceneId::kNone);
}

TEST_CASE("scene: the ring column matches RingMode") {
  CHECK(static_cast<uint8_t>(Ring::kOff) == static_cast<uint8_t>(bob::RingMode::kOff));
  CHECK(static_cast<uint8_t>(Ring::kListening) == static_cast<uint8_t>(bob::RingMode::kListening));
  CHECK(static_cast<uint8_t>(Ring::kThinking) == static_cast<uint8_t>(bob::RingMode::kThinking));
  CHECK(static_cast<uint8_t>(Ring::kSpeaking) == static_cast<uint8_t>(bob::RingMode::kSpeaking));
  CHECK(static_cast<uint8_t>(Ring::kError) == static_cast<uint8_t>(bob::RingMode::kError));
  CHECK(static_cast<uint8_t>(Ring::kNotify) == static_cast<uint8_t>(bob::RingMode::kNotify));
  CHECK(static_cast<uint8_t>(Ring::kSleep) == static_cast<uint8_t>(bob::RingMode::kSleep));
}

TEST_CASE("scene: duration clamps to 1..20 s and 0 means the scene's default") {
  const SceneId id = idFromName("timer_set");
  CHECK(durationSeconds(id, 0) == specOf(id).seconds);
  CHECK(durationSeconds(id, 1) == 1);
  CHECK(durationSeconds(id, 7) == 7);
  CHECK(durationSeconds(id, 20) == 20);
  CHECK(durationSeconds(id, 21) == 20);
  CHECK(durationSeconds(id, 100000) == 20);
}

TEST_CASE("scene: the caption is one short line, a timer's length as m:ss") {
  char out[40];
  caption(idFromName("timer_set"), "", 600, out, sizeof(out));
  CHECK(std::string(out) == "10:00");
  caption(idFromName("timer_set"), "", 75, out, sizeof(out));
  CHECK(std::string(out) == "1:15");
  caption(idFromName("timer_done"), "tea", 3725, out, sizeof(out));
  CHECK(std::string(out) == "1:02:05");
  caption(idFromName("task_added"), "Buy milk", 0, out, sizeof(out));
  CHECK(std::string(out) == "Buy milk");
  caption(idFromName("weather_sun"), "", 0, out, sizeof(out));
  CHECK(std::string(out).empty());
  caption(idFromName("note_added"), "123456789012345678901234567890", 0, out, sizeof(out));
  CHECK(std::strlen(out) == kLabelMax);
}

TEST_CASE("scene: the Cardputer gets one line of icon text with the same information") {
  char out[48];
  iconLine(idFromName("timer_set"), "", 600, out, sizeof(out));
  CHECK(std::string(out) == "[clock] 10:00");
  iconLine(idFromName("weather_sun"), "", 0, out, sizeof(out));
  CHECK(std::string(out) == "[sun]");
  iconLine(idFromName("task_added"), "Buy milk", 0, out, sizeof(out));
  CHECK(std::string(out) == "[task] Buy milk");
}

TEST_CASE("scene: parsing the scene message") {
  bool ok = false;
  bob::SceneMessage m = parse("{\"v\":2,\"type\":\"scene\",\"id\":\"a1\",\"payload\":{\"scene\":\"timer_set\",\"seconds\":6,\"label\":\"Tea\",\"value\":600}}", &ok);
  REQUIRE(ok);
  CHECK(std::string(m.scene) == "timer_set");
  CHECK(m.seconds == 6);
  CHECK(std::string(m.label) == "Tea");
  CHECK(m.hasValue);
  CHECK(m.value == 600);
  m = parse("{\"v\":2,\"type\":\"scene\",\"id\":\"a2\",\"payload\":{\"scene\":\"weather_sun\"}}", &ok);
  REQUIRE(ok);
  CHECK(std::string(m.scene) == "weather_sun");
  CHECK(m.seconds == 0);
  CHECK_FALSE(m.hasValue);
  CHECK(std::string(m.label).empty());
  m = parse("{\"v\":2,\"type\":\"scene\",\"id\":\"a3\",\"payload\":{\"scene\":\"made_up\",\"seconds\":3}}", &ok);
  REQUIRE(ok);  // unknown names parse; the caller ignores them
  CHECK(idFromName(m.scene) == SceneId::kNone);
  m = parse("{\"v\":2,\"type\":\"scene\",\"id\":\"a4\",\"payload\":{\"value\":-5,\"scene\":\"music\"}}", &ok);
  REQUIRE(ok);
  CHECK(m.value == -5);
  parse("{\"v\":2,\"type\":\"scene\",\"id\":\"a5\"}", &ok);
  CHECK_FALSE(ok);
  parse("{\"v\":2,\"type\":\"scene\",\"id\":\"a6\",\"payload\":{\"seconds\":4}}", &ok);
  CHECK_FALSE(ok);
  parse("{\"v\":2,\"type\":\"scene\",\"id\":\"a7\",\"payload\":{\"scene\":\"\"}}", &ok);
  CHECK_FALSE(ok);
  CHECK(bob::isScene(String("{\"v\":2,\"type\":\"scene\",\"id\":\"a\",\"payload\":{}}")));
  CHECK_FALSE(bob::isScene(String("{\"v\":2,\"type\":\"announce\",\"payload\":{}}")));
}

TEST_CASE("scene: keyframes interpolate between keys and hit the end values") {
  const Keyframe keys[] = {{0.0f, 0, 10, 0.5f, -10, 0.0f}, {1.0f, 20, 0, 1.0f, 10, 1.0f}};
  Transform t = sampleKeys(keys, 2, 0.0f);
  CHECK(t.y == doctest::Approx(10.0f));
  CHECK(t.alpha == doctest::Approx(0.0f));
  t = sampleKeys(keys, 2, 1.0f);
  CHECK(t.x == doctest::Approx(20.0f));
  CHECK(t.scale == doctest::Approx(1.0f));
  CHECK(t.alpha == doctest::Approx(1.0f));
  t = sampleKeys(keys, 2, 2.0f);  // past the end: held
  CHECK(t.x == doctest::Approx(20.0f));
  t = sampleKeys(keys, 2, -1.0f);  // before the start: held
  CHECK(t.x == doctest::Approx(0.0f));
  t = sampleKeys(keys, 2, 0.5f);
  CHECK(t.x > 0.0f);
  CHECK(t.x < 25.0f);
  CHECK(sampleKeys(keys, 0, 0.5f).scale == doctest::Approx(1.0f));
}

TEST_CASE("scene: layers run on independent clocks") {
  LayerClock loop;
  loop.startMs = 1000;
  loop.durMs = 400;
  loop.loop = true;
  CHECK(loop.phase(500) == doctest::Approx(0.0f));  // before its start
  CHECK(loop.phase(1200) == doctest::Approx(0.5f));
  CHECK(loop.phase(1400) == doctest::Approx(0.0f));  // wrapped
  LayerClock once;
  once.startMs = 1000;
  once.durMs = 400;
  CHECK(once.phase(1200) == doctest::Approx(0.5f));
  CHECK(once.phase(5000) == doctest::Approx(1.0f));  // holds
  // The second prop's clock starts 200 ms after the first; the caption starts later still.
  CHECK(propClockMs(0, 100) == 100);
  CHECK(propClockMs(1, 100) == 0);
  CHECK(propClockMs(1, 500) == 300);
  CHECK(propTransform(0, 175, 6000).scale != propTransform(1, 175, 6000).scale);  // different phases at the same instant
  CHECK(captionAlpha(100, 6000) == doctest::Approx(0.0f));
}

TEST_CASE("scene: props pop in with a spring and fade out with the scene") {
  Transform t = propTransform(0, 0, 6000);
  CHECK(t.alpha == doctest::Approx(0.0f));
  CHECK(t.scale < 0.6f);
  t = propTransform(0, kEnterMs, 6000);
  CHECK(t.alpha == doctest::Approx(1.0f));
  CHECK(t.scale == doctest::Approx(1.0f));
  float peak = 0.0f;
  for (uint32_t ms = 0; ms <= kEnterMs; ms += 10) peak = fmaxf(peak, propTransform(0, ms, 6000).scale);
  CHECK(peak > 1.0f);  // a small overshoot
  CHECK(peak < 1.2f);
  CHECK(exitAlpha(5000, 6000) == doctest::Approx(1.0f));
  CHECK(exitAlpha(5850, 6000) == doctest::Approx(0.5f));
  CHECK(exitAlpha(6000, 6000) == doctest::Approx(0.0f));
  CHECK(propTransform(0, 5999, 6000).alpha < 0.01f);
  CHECK(captionAlpha(1000, 6000) == doctest::Approx(1.0f));
  CHECK(captionAlpha(6000, 6000) == doctest::Approx(0.0f));
}
