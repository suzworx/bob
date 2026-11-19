// Bob — `T ui <name>` (hil env only): draws one round-UI screen with sample data so it can be
// reviewed with `T screenshot`. Nothing here ships in the product build.
#if defined(BOB_BOARD_WAVESHARE_185C) && defined(BOB_TEST_CONSOLE)

#include <Arduino.h>
#include <string.h>

#include "bob_motion.h"
#include "cards.h"
#include "display.h"
#include "round_feedback.h"
#include "round_ring.h"
#include "round_ui.h"

namespace bob
{
namespace fsm
{
extern State state;                                          // state_core.cpp
void journalEvent(const char* event, const String& detail); // state_core.cpp
}

namespace roundui
{
namespace
{
void mood(UiMood m, const char* line)
{
  clearScreen();
  showBob(m);
  ringLightSetMode(ringModeForMood(static_cast<uint8_t>(m), false), millis());
  if (line != nullptr) { textCentered(line, kRuiCaptionY, m == UiMood::kError ? bobtok::kCoral : kRuiText, detailFont()); }
}

// `T ui colortest`: patches of the brand colours, pure primaries and a grey ramp, each journalled with the
// RGB565 value the framebuffer stores and so pushes to the glass (v2.colortest). A photo of the glass
// against these values separates a panel-output cast (gamma, inversion) from the framebuffer's colours.
void colorTest()
{
  struct Patch { const char* name; uint32_t rgb; };
  static const Patch kBrand[] = {{"ink", 0x173E57}, {"paper", 0xFFFDF6}, {"yellow", 0xF0C75E}, {"sky", 0xBBDDF0}};
  static const Patch kPrimary[] = {{"red", 0xFF0000}, {"green", 0x00FF00}, {"blue", 0x0000FF}, {"white", 0xFFFFFF}};
  clearScreen();
  demoHold(true);
  auto& d = fb();
  auto patch = [&](const Patch& p, int x, int y, int w, int h) {
    d.fillRect(x, y, w, h, p.rgb);
    const uint32_t stored = d.readPixelValue(x + w / 2, y + h / 2) & 0xFFFF;
    const uint16_t rgb565 = static_cast<uint16_t>(((p.rgb >> 8) & 0xF800) | ((p.rgb >> 5) & 0x07E0) | ((p.rgb >> 3) & 0x001F));
    fsm::journalEvent("colortest", String("patch=") + p.name + ",rgb888=" + String(p.rgb, HEX) + ",rgb565=" + String(rgb565, HEX) +
                                       ",fb_raw=" + String(static_cast<unsigned long>(stored), HEX) + ",at=" + x + "," + y);
  };
  for (int i = 0; i < 4; ++i) { patch(kBrand[i], 50 + i * 65, 70, 60, 60); }
  for (int i = 0; i < 4; ++i) { patch(kPrimary[i], 50 + i * 65, 135, 60, 60); }
  for (int i = 0; i < 8; ++i)
  {
    const uint32_t v = static_cast<uint32_t>(i * 255 / 7);
    char name[12];
    snprintf(name, sizeof(name), "grey%d", i);
    patch(Patch{name, (v << 16) | (v << 8) | v}, 46 + i * 33, 205, 31, 50);
  }
  dirtyAll();
}

void sampleCards(const char* name, bool dots = true)
{
  static ReplyText reply;
  static Announcement note;
  if (strcmp(name, "reply") == 0)
  {
    snprintf(reply.heard, sizeof(reply.heard), "Will it rain today?");
    snprintf(reply.reply, sizeof(reply.reply), "Rain is likely after 3 pm. Take a jacket.");
    layoutReplyCard(reply);
    demoReplyPages(dots ? 3 : 0); // the demo's reply list has three replies: three page dots (the Speaking view shows none)
    drawReplyCard(reply, 0);
  }
  else
  {
    note.kind = AnnounceKind::kTimer;
    snprintf(note.title, sizeof(note.title), "Pasta");
    snprintf(note.body, sizeof(note.body), "Your ten minute timer is done.");
    drawAnnouncementCard(note, true, false);
  }
}
} // namespace

bool demoScreen(const char* name)
{
  const uint32_t now = millis();
  StatusLineView view;
  view.mode = DeviceMode::kWake;
  view.volume = 8; // the same sample status the demo page and tokens.json states use (volume-2, battery 82%)
  view.batteryPct = 82;
  view.charging = 0;
  view.wifiOk = true;
  view.micOpen = strcmp(name, "listening") == 0;
  view.dnd = strcmp(name, "sleeping") == 0;
  chromeSetStatus(view);
  setServerOk(strcmp(name, "offline") != 0 && strcmp(name, "hello") != 0);
  demoWifi(strcmp(name, "offline") == 0 ? 3 : strcmp(name, "hello") == 0 ? 4 : 0);
  demoChips(strcmp(name, "ready") != 0 && strcmp(name, "info") != 0);
  demoHold(strcmp(name, "ready") != 0 && strcmp(name, "info") != 0);
  if (strcmp(name, "ready") == 0 || strcmp(name, "info") == 0)
  {
    drawReadyScreen("Your Bob", "Weekend plans", "Home", true, true, nullptr, "BOB v2 READY");
    if (name[0] == 'i') { roundUiToggleInfo(now); }
  }
  else if (strcmp(name, "listening") == 0) { mood(UiMood::kListening, bobtok::kCaptionListening); updateListeningIndicator(now); }
  else if (strcmp(name, "colortest") == 0) { colorTest(); }
  else if (strncmp(name, "wifi-", 5) == 0)
  {
    const int mode = strcmp(name + 5, "strong") == 0 ? 1 : strcmp(name + 5, "weak") == 0 ? 2 : strcmp(name + 5, "off") == 0 ? 3
                     : strcmp(name + 5, "connecting") == 0 ? 4 : 0;
    if (mode == 0) { return false; }
    drawReadyScreen("Your Bob", "Weekend plans", "Home", true, true, nullptr, "BOB v2 READY");
    demoWifi(mode);
    demoHold(false);
  }
  else if (strcmp(name, "sleeping") == 0) { mood(UiMood::kSleeping, nullptr); }
  else if (strcmp(name, "thinking") == 0) { mood(UiMood::kThinking, nullptr); }
  else if (strcmp(name, "speaking") == 0)
  {
    // The demo's Speaking: Bob small and high speaking, the first lines of the reply under him (the reply card without its dots), the ring
    // glowing with the voice.
    sampleCards("reply", false);
    sceneBob(BobEmotion::kSpeaking);
    bobMotionSetStage(bobtok::kBobScaleSpeaking, bobtok::kBobRiseSpeaking);
    updatePlaybackIndicator(now, 1);
  }
  else if (strcmp(name, "speaking-live") == 0)
  {
    // The reply's words while it plays (#1063): a three-page reply over the speaking Bob, page 1 of 3.
    static ReplyText reply;
    snprintf(reply.reply, sizeof(reply.reply), "Rain is likely after 3 pm, so take a jacket. Your first meeting is at 9:30 "
                                               "in the big room. Pasta is on the shopping list, and the milk is low too.");
    layoutReplyCard(reply);
    drawSpeakingReply(reply, 0);
    updatePlaybackIndicator(now, 1);
  }
  else if (strcmp(name, "trouble") == 0)
  {
    drawReadyScreen("Your Bob", "Weekend plans", "Home", true, true, nullptr, "BOB v2 READY");
    roundUiTrouble("Didn't catch that", now);
  }
  else if (strcmp(name, "error-retry") == 0 || strcmp(name, "connecting") == 0)
  {
    // The real status screens (drawStatus), not the demo's token captions: the state decides the pose.
    const State was = fsm::state;
    const bool error = name[0] == 'e';
    fsm::state = error ? State::kError : State::kWifi;
    drawStatus(error ? "MIC ERROR" : bobtok::kCaptionConnecting, "", error ? kColorRed : kColorGreen, true, !error);
    fsm::state = was;
  }
  else if (strcmp(name, "hello") == 0) { mood(UiMood::kHello, bobtok::kCaptionConnecting); }
  else if (strcmp(name, "offline") == 0) { mood(UiMood::kOffline, bobtok::kCaptionOffline); }
  else if (strcmp(name, "error") == 0) { mood(UiMood::kError, bobtok::kCaptionError); }
  else if (strcmp(name, "updating") == 0) { mood(UiMood::kUpdating, bobtok::kCaptionUpdating); }
  else if (strcmp(name, "pairing") == 0)
  {
    PairingInfo info;
    snprintf(info.userCode, sizeof(info.userCode), "4K7-Q2X");
    snprintf(info.verificationUri, sizeof(info.verificationUri), "app.heybob.xyz/pair");
    info.expiresAtMs = now + 298000;
    drawPairingScreen(info, now);
  }
  else if (strcmp(name, "help") == 0) { drawHelp(0, "Hey Bob"); }
  else if (strcmp(name, "reply") == 0 || strcmp(name, "announce") == 0) { sampleCards(name); }
  else if (strcmp(name, "picker") == 0)
  {
    ListedConversation rows[4] = {};
    const char* titles[4] = {"Weekend plans", "New conversation", "Recipe ideas", "Trip to Tokyo"};
    for (int i = 0; i < 4; ++i) { snprintf(rows[i].title, sizeof(rows[i].title), "%s", titles[i]); }
    drawConversationList(rows, 4, 1);
  }
  else if (strcmp(name, "field") == 0) { drawFieldScreen("WI-FI PASSWORD", "Network: Home", "hunter2", 7, "7/63", ""); }
  else if (strcmp(name, "lines") == 0)
  {
    const char* lines[] = {"Firmware 0.144.0", "Waveshare round", "Paired and online"};
    drawLinesScreen("ABOUT", kColorWhite, lines, 3);
  }
  else { return false; }
  return true;
}

} // namespace roundui
} // namespace bob

#endif
