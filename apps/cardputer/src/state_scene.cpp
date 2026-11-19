// Bob — Bob's action scenes (BOB-SCENES): the server's `scene` message and the HIL console's `T scene`.
// The round UI plays the scene (scene_engine.cpp); a Cardputer has no art and shows one line of icon text, so the
// information is the same on both. The scene is chosen by the server from the agent's tool, never from a phrase.
#include "state_internal.h"

#include <stdio.h>

#include "chrome.h"
#include "scene_engine.h"

namespace bob {

namespace fsm {

namespace {

// Plays `id` where Bob is on screen (READY, or AWAITING while he speaks: he keeps his beat, the props play).
bool showScene(scene::SceneId id, uint32_t seconds, const char* label, bool hasValue, int32_t value) {
  const char* name = scene::specOf(id).name;
  if (state != State::kReady && state != State::kAwaiting) {
    journalEvent("scene_skipped", String("name=") + name + ",reason=state");
    return false;
  }
  const uint8_t secs = scene::durationSeconds(id, seconds);
#if defined(BOB_BOARD_WAVESHARE_185C)
  return sceneBegin(id, secs, label, hasValue ? value : 0, state == State::kAwaiting, millis());
#else
  char line[48];
  scene::iconLine(id, label, hasValue ? value : 0, line, sizeof(line));
  chromeToast(line, millis());
  journalEvent("scene", String("name=") + name + ",line=1,seconds=" + secs);
  return true;
#endif
}

}  // namespace

void handleScene(const String& text) {
  SceneMessage message;
  if (!parseScene(text, message)) {
    journalEvent("scene_bad");
    return;
  }
  const scene::SceneId id = scene::idFromName(message.scene);
  if (id == scene::SceneId::kNone) {
    journalEvent("scene_unknown", String("name=") + message.scene);  // a newer server: ignore it, never fail
    return;
  }
  showScene(id, message.seconds, message.label, message.hasValue, message.value);
}

}  // namespace fsm

// `T scene <name> [seconds [value]]` (test console): force a scene, for screenshots and the frame budget.
bool testShowScene(const char* args) {
  char name[scene::kLabelMax] = "";
  unsigned seconds = 0;
  int value = 0;
  const int n = sscanf(args, "%23s %u %d", name, &seconds, &value);
  if (n < 1) return false;
  const scene::SceneId id = scene::idFromName(name);
  if (id == scene::SceneId::kNone) return false;
  return fsm::showScene(id, seconds, "", n >= 3, value);
}

}  // namespace bob
