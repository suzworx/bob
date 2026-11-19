// Bob Cardputer v2 — the HIL serial test console (docs/cardputer/hil.md).
// Only the m5stack-cardputer-hil env defines BOB_TEST_CONSOLE; the product
// build compiles this file to nothing.
#include "test_console.h"
#if defined(BOB_BOARD_WAVESHARE_185C)
#include "audio_duplex.h"
#include "round_ring.h"
#include "bob_moves.h"
#include "bob_motion.h"
#include "round_touch.h"
#include "ws185_hw.h"
#include "ws185_panel_tune.h"
#include "round_ui.h"
#endif

#ifdef BOB_TEST_CONSOLE

#include <Arduino.h>
#include <WiFi.h>
#include <cstdlib>
#include <cstring>
#include <esp_heap_caps.h>
#include <mbedtls/sha256.h>
#include <memory>
#include <new>
#include "build_id.h"
#include "audio_playback.h"
#include "device_settings.h"
#include "device_token.h"
#include "earcons.h"
#include "journal.h"
#include "net_store.h"
#include "types.h"
#include "usb_packet.h"

namespace bob {

// `T token forget` (state.cpp); declared here, not in test_console.h.
void testForgetToken();
// `T hello pcm|mp3` (state.cpp): the format of every later hello, RAM only.
bool testSetHelloFormat(const char* name);
// `T srv set dev <host> <port>` | `T srv set prod` (state_connection.cpp): the server profile for a HIL run.
String testSetServerProfile(const char* args);
// `T scene <name> [seconds [value]]` (state_scene.cpp): force one of Bob's scenes.
bool testShowScene(const char* args);
// `T aec cal|dt|delay` refuses unless READY; `aec cal` also refuses in wake mode, which keeps the wake mic (state_turn.cpp).
bool testStateReady();

namespace {

constexpr size_t kMaxLineChars = 64;  // longer lines are dropped whole.
constexpr uint32_t kMaxToneMs = 10000;

char g_line[kMaxLineChars + 1];
size_t g_length = 0;
bool g_overflow = false;

// The device's id for HIL records: the first 12 hex digits of sha256 over
// the MAC as 12 lowercase hex digits (scripts/device-attest.mjs deviceIdFromMac
// computes the same). The raw MAC never reaches serial or the run logs.
String deviceId() {
  uint8_t mac[6] = {};
  WiFi.macAddress(mac);
  char hex[13];
  snprintf(hex, sizeof(hex), "%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3],
           mac[4], mac[5]);
  uint8_t digest[32];
  if (mbedtls_sha256_ret(reinterpret_cast<const unsigned char*>(hex), 12, digest, 0) != 0) {
    return "unknown";
  }
  char id[13];
  for (size_t i = 0; i < 6; ++i) snprintf(id + 2 * i, 3, "%02x", digest[i]);
  return String(id);
}

// `T net dump`: the saved networks by slot id, priority order, flags and last
// join result. Never an SSID or password (#675).
String netDump() {
  std::unique_ptr<NetworkList> list(new (std::nothrow) NetworkList);
  if (!list) return "err alloc";
  netLoad(deviceStore(), *list);
  String out = String("net count=") + list->count + " order=";
  for (uint8_t r = 0; r < list->count; ++r) out += String(r ? "," : "") + list->order[r];
  for (uint8_t r = 0; r < list->count; ++r) {
    const SavedNetwork& net = list->slot[list->order[r]];
    out += String(" s") + list->order[r] + "=flags:" + net.flags +
           ",last:" + static_cast<uint8_t>(net.last);
  }
  memset(list.get(), 0, sizeof(NetworkList));
  return out;
}

// `T srv dump`: the active profile, its TLS flag and which tokens exist.
// Never a host, port or token (#675).
String srvDump() {
  KvStore& kv = deviceStore();
  return String("srv profile=") + profileName(activeProfile()) +
         " tls=" + (activeEndpoint().tls ? 1 : 0) + " dev_options=" + (kDevOptions ? 1 : 0) +
         " tok=prod:" + (tokenHas(kv, Profile::kProd) ? 1 : 0) +
         ",dev:" + (tokenHas(kv, Profile::kDev) ? 1 : 0) +
         ",custom:" + (tokenHas(kv, Profile::kCustom) ? 1 : 0) +
         " legacy=" + (kv.bytesLength(kTokenNamespace, kLegacyTokenKey) > 0 ? 1 : 0);
}

// `T token backup|restore` (pair-from-scratch, revoke-4003). A scenario that
// pairs from scratch first backs the active profile's token up under a
// test-only key ("hil_" + its token key, namespace "bob"), and puts it back
// at its end, so a run never leaves the device paired only to the HIL server
// that is gone afterwards. backup keeps an existing backup (a run that failed
// midway left the owner's token there). `T token forget` is testForgetToken.
// The token is never printed.
const char* tokenCommand(const char* action) {
  const bool backup = strcmp(action, "backup") == 0;
  if (!backup && strcmp(action, "restore") != 0) return "err action";
  KvStore& kv = deviceStore();
  const Profile profile = activeProfile();
  const String backupKey = String("hil_") + tokenKey(profile);
  char token[kDeviceTokenBytes] = {};
  const size_t saved = kv.bytesLength(kTokenNamespace, backupKey.c_str());
  const char* reply = "ok restored";
  if (backup) {
    const bool hasToken = tokenLoad(kv, profile, token, sizeof(token));
    const size_t len = strlen(token);
    reply = saved > 0   ? "ok kept"
            : !hasToken ? "ok none"
            : kv.putBytes(kTokenNamespace, backupKey.c_str(), token, len) ? "ok saved"
                                                                          : "err nvs";
  } else if (saved == 0 || saved >= sizeof(token)) {
    reply = "err no_backup";
  } else if (kv.getBytes(kTokenNamespace, backupKey.c_str(), token, saved) != saved ||
             !tokenSave(kv, profile, token)) {
    reply = "err nvs";
  } else {
    kv.remove(kTokenNamespace, backupKey.c_str());
  }
  memset(token, 0, sizeof(token));
  return reply;
}

void runCommand(const char* line) {
  if (strncmp(line, "T ", 2) != 0) return;  // not ours: stay silent.
  const char* cmd = line + 2;
  if (strcmp(cmd, "ping") == 0) {
    consoleReply(String("pong fw=") + kFirmwareVersion + " build=" + BOB_BUILD_ID_TEXT +
                 " id=" + deviceId());
  } else if (strncmp(cmd, "key ", 4) == 0 && strlen(cmd) == 5 && cmd[4] > ' ' && cmd[4] < 0x7f) {
    testPressKey(cmd[4]);
    consoleReply("ok");
  } else if (strcmp(cmd, "enter") == 0) {
    testPressEnter();
    consoleReply("ok");
  } else if (strcmp(cmd, "del") == 0) {
    testPressDel();
    consoleReply("ok");
  } else if (strcmp(cmd, "tab") == 0) {
    testPressTab();
    consoleReply("ok");
  } else if (strncmp(cmd, "fn ", 3) == 0 && strlen(cmd) == 4 && cmd[3] > ' ' && cmd[3] < 0x7f) {
    testPressFn(cmd[3]);
    consoleReply("ok");  // never echoes the key: it may be part of a password
  } else if (strcmp(cmd, "backtick") == 0) {
    testPressKey('`');
    consoleReply("ok");
  } else if (strcmp(cmd, "btn down") == 0 || strcmp(cmd, "btn up") == 0) {
    testSetGo(cmd[4] == 'd');
    consoleReply("ok");
  } else if (strcmp(cmd, "state") == 0) {
    consoleReply(testStateLine());
#if defined(BOB_BOARD_WAVESHARE_185C)
  } else if (strcmp(cmd, "screenshot") == 0) {
    roundui::dumpFramebuffer();
  } else if (strcmp(cmd, "spk test") == 0) {
    // `T spk test` (P0 #1063): a 1 kHz tone through the ES8311 + amp, heard back through the ES7210.
    // Only while nothing else holds I2S0: READY in push-to-talk (the mic is off), no reply or tone.
    if (M5.Mic.isRunning() || M5.Speaker.isPlaying()) {
      consoleReply("err spk_busy");
      return;
    }
    releaseSpeakerForMic();  // frees I2S0 and marks the speaker for re-install
    spktest::Levels levels;
    uint32_t micSamples = 0;
    const bool ran = ws185::speakerSelfTest(&levels, &micSamples);
    char codec[96] = "";
    ws185::codecState(codec, sizeof(codec));
    const spktest::Verdict v = spktest::judge(levels, ran ? micSamples : 0);
    const String detail = String("pass=") + (v.pass ? 1 : 0) + ",stage=" + (ran ? v.stage : "i2s") +
                          ",tone_rms=" + String(levels.toneRms, 0) + ",quiet_rms=" + String(levels.quietRms, 0) +
                          ",amp_off_rms=" + String(levels.ampOffRms, 0) + ",rise_db=" + String(v.riseDb, 1) +
                          ",amp_off_rise_db=" + String(v.ampOffRiseDb, 1) + ",mic_samples=" + micSamples + "," + codec;
    journal("spk_test", State::kReady, "", detail);
    consoleReply(String("spk_test ") + detail);
  } else if (strncmp(cmd, "bright ", 7) == 0) {
    // `T bright 0..255`: the backlight level (default 200), for the dark-tone / night-use checks.
    const long level = strtol(cmd + 7, nullptr, 10);
    if (level < 0 || level > 255) {
      consoleReply("err bright");
    } else {
      M5.Display.setBrightness(static_cast<uint8_t>(level));
      consoleReply(String("ok bright=") + level + " duty=" + ws185tune::backlightDuty(static_cast<uint8_t>(level)) + "/" +
                   ws185tune::kBacklightDutyMax);
    }
  } else if (strncmp(cmd, "gamma ", 6) == 0) {
    // `T gamma ws|esp|nt150|sym` (presets, include/ws185_panel_tune.h) or `T gamma p|n <14 hex bytes>`
    // (E0 or E1 alone, the other kept). #1065, docs/waveshare/navy-1065.md.
    const char* arg = cmd + 6;
    const ws185tune::GammaPreset* preset = ws185tune::findGammaPreset(arg);
    uint8_t bytes[ws185tune::kGammaBytes];
    if (preset != nullptr) {
      ws185::panelGamma(preset->pos, preset->neg, preset->name);
    } else if ((arg[0] == 'p' || arg[0] == 'n') && arg[1] == ' ' &&
               ws185tune::parseHexBytes(arg + 2, bytes, sizeof(bytes)) == static_cast<int>(sizeof(bytes))) {
      uint8_t pos[ws185tune::kGammaBytes], neg[ws185tune::kGammaBytes];
      ws185::panelGammaCurrent(pos, neg);
      memcpy(arg[0] == 'p' ? pos : neg, bytes, sizeof(bytes));
      ws185::panelGamma(pos, neg, "raw");
    } else {
      consoleReply("err gamma (ws|esp|nt150|sym|p <14 hex>|n <14 hex>)");
      return;
    }
    char dump[320];
    ws185::panelDump(dump, sizeof(dump));
    consoleReply(String("ok ") + dump);
  } else if (strcmp(cmd, "inv 0") == 0 || strcmp(cmd, "inv 1") == 0) {
    // `T inv 0|1`: INVOFF (0x20) / INVON (0x21); the product sends INVON.
    const bool on = cmd[4] == '1';
    ws185::panelInvert(on);
    consoleReply(String("ok inv=") + (on ? "1 sent=21 INVON" : "0 sent=20 INVOFF"));
  } else if (strncmp(cmd, "madctl ", 7) == 0) {
    // `T madctl <hex>`: 0x36 raw. 00 = the product (RGB, rotation 0); 08 = BGR. Redraws everything.
    uint8_t v = 0;
    if (ws185tune::parseHexBytes(cmd + 7, &v, 1) != 1) {
      consoleReply("err madctl");
    } else {
      ws185::panelMadctl(v);
      roundui::dirtyAll();
      char bits[24];
      ws185tune::describeMadctl(v, bits, sizeof(bits));
      consoleReply(String("ok madctl=") + String(v, HEX) + " (" + bits + ")");
    }
  } else if (strcmp(cmd, "panel dump") == 0) {
    char dump[320];
    ws185::panelDump(dump, sizeof(dump));
    consoleReply(dump);
  } else if (strcmp(cmd, "panel id") == 0) {
    uint8_t id[4] = {};
    ws185::panelReadId(id);
    char line[96];
    snprintf(line, sizeof(line), "panel id=%02X %02X %02X %02X table=%s (ws: 00 02 7F 7F, esp: 00 7F 7F 7F)", id[0], id[1], id[2],
             id[3], ws185tune::tableForPanelId(id));
    consoleReply(line);
  } else if (strcmp(cmd, "panel init ws") == 0 || strcmp(cmd, "panel init esp") == 0) {
    // `T panel init ws|esp`: the whole init table again (esp clears the panel RAM), then a full redraw.
    ws185::panelInit(cmd + 11);
    roundui::dirtyAll();
    char dump[320];
    ws185::panelDump(dump, sizeof(dump));
    consoleReply(String("ok ") + dump);
  } else if (strncmp(cmd, "panel ", 6) == 0) {
    // `T panel 21` / `T panel F0 02 E0 ...`: hex bytes, the first is the ST77916 command.
    uint8_t bytes[17];
    size_t count = 0;
    const char* p = cmd + 6;
    char* end = nullptr;
    while (*p != '\0' && count < sizeof(bytes)) {
      const unsigned long v = strtoul(p, &end, 16);
      if (end == p || v > 0xFF) break;
      bytes[count++] = static_cast<uint8_t>(v);
      p = end;
      while (*p == ' ') ++p;
    }
    if (count == 0 || *p != '\0') {
      consoleReply("err panel");
    } else {
      ws185::panelCommand(bytes[0], bytes + 1, static_cast<uint8_t>(count - 1));
      consoleReply("ok");
    }
  } else if (strncmp(cmd, "touch ", 6) == 0) {
    int x = 0, y = 0, ms = 120;
    const int n = sscanf(cmd + 6, "%d %d %d", &x, &y, &ms);
    if (n < 2) {
      consoleReply("err touch");
    } else {
      roundtouch::injectGesture(static_cast<int16_t>(x), static_cast<int16_t>(y), static_cast<int16_t>(x), static_cast<int16_t>(y),
                                static_cast<uint32_t>(ms));
      consoleReply("ok");
    }
  } else if (strncmp(cmd, "swipe ", 6) == 0) {
    const char* dir = cmd + 6;
    int dx = 0, dy = 0;
    if (strcmp(dir, "up") == 0) dy = -120;
    else if (strcmp(dir, "down") == 0) dy = 120;
    else if (strcmp(dir, "left") == 0) dx = -120;
    else if (strcmp(dir, "right") == 0) dx = 120;
    if (dx == 0 && dy == 0) {
      consoleReply("err swipe");
    } else {
      roundtouch::injectGesture(static_cast<int16_t>(180 - dx / 2), static_cast<int16_t>(190 - dy / 2),
                                static_cast<int16_t>(180 + dx / 2), static_cast<int16_t>(190 + dy / 2), 260);
      consoleReply("ok");
    }
  } else if (strncmp(cmd, "ring ", 5) == 0) {
    // `T ring <name>`: plays a state, emotion or scene on the ring light (round_ring_spec.h table).
    // The reply carries the last frame's cost against the 5 ms budget.
    if (ringLightPlay(cmd + 5, millis())) {
      const RingStats st = ringLightStats();
      consoleReply(String("ok ring=") + (cmd + 5) + " compose_us=" + st.composeUs + " frame_us=" + st.frameUs +
                   " max_us=" + st.maxFrameUs + " segs=" + st.segments);
    } else {
      consoleReply("err ring");
    }
  } else if (strncmp(cmd, "ui ", 3) == 0) {
    consoleReply(roundui::demoScreen(cmd + 3) ? "ok" : "err ui");
  } else if (strcmp(cmd, "move") == 0 || strcmp(cmd, "move list") == 0) {
    // `T move`: every rig move name (bob_moves.h), comma separated, plus whether the rig is drawing Bob.
    String names = bobMotionRigActive() ? "rig:" : "pose:";
    for (uint8_t i = 0; i < moves::kMoveCount; ++i) names += String(i ? "," : "") + moves::kMoves[i].name;
    consoleReply(names);
  } else if (strncmp(cmd, "move ", 5) == 0) {
    // `T move <name>`: plays that move once over the current emotion (e.g. T move backflip).
    consoleReply(bobMotionPlayMove(cmd + 5) ? String("ok move ") + (cmd + 5) : String("err move"));
  } else if (strcmp(cmd, "aec cal") == 0) {
    // `T aec cal`: the echo canceller's delay calibration (audio_duplex.h). READY only, so no reply plays.
    if (!testStateReady()) {
      consoleReply("err busy");
    } else {
      const int delay = duplex::calibrate();
      if (delay < 0) {
        consoleReply("err cal");
      } else {
        consoleReply(String("ok delay=") + delay);
      }
    }
  } else if (strncmp(cmd, "aec dt ", 7) == 0) {
    // `T aec dt <ratio>`: the two-path copy ratio (audio_duplex.h).
    char* end = nullptr;
    const float ratio = strtof(cmd + 7, &end);
    if (end == cmd + 7 || *end != '\0') {
      consoleReply("err dt");
    } else {
      duplex::setDoubleTalkThreshold(ratio);
      consoleReply("ok");
    }
  } else if (strncmp(cmd, "aec delay ", 10) == 0) {
    // `T aec delay <samples>`: the bulk delay the canceller searches around (audio_duplex.h).
    char* end = nullptr;
    const unsigned long samples = strtoul(cmd + 10, &end, 10);
    if (end == cmd + 10 || *end != '\0') {
      consoleReply("err delay");
    } else {
      duplex::setBulkDelay(static_cast<size_t>(samples));
      consoleReply("ok");
    }
#endif
  } else if (strncmp(cmd, "scene ", 6) == 0) {
    consoleReply(testShowScene(cmd + 6) ? "ok" : "err scene");
  } else if (strcmp(cmd, "heap") == 0) {
    consoleReply(String("free=") + heap_caps_get_free_size(MALLOC_CAP_8BIT) +
                 " min=" + heap_caps_get_minimum_free_size(MALLOC_CAP_8BIT) +
                 " largest=" + heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
  } else if (strncmp(cmd, "audio tone ", 11) == 0) {
    char* end = nullptr;
    const unsigned long ms = strtoul(cmd + 11, &end, 10);
    if (end == cmd + 11 || *end != '\0' || ms == 0 || ms > kMaxToneMs) {
      consoleReply("err tone_ms");
      return;
    }
    testArmTone(static_cast<uint32_t>(ms));
    consoleReply("ok");
  } else if (strcmp(cmd, "state reset") == 0) {
    testResetCounters();
    consoleReply("ok");
  } else if (strncmp(cmd, "wake word ", 10) == 0) {
    consoleReply(testSetWakeWord(cmd + 10) ? "ok" : "err word");
  } else if (strcmp(cmd, "wake bob") == 0) {
    consoleReply(testSetWakeWire(cmd + 5) ? "ok" : "err word");
  } else if (strcmp(cmd, "wake fire") == 0) {
    consoleReply(testFireWake() ? "ok" : "err not_listening");
  } else if (strcmp(cmd, "net dump") == 0) {
    consoleReply(netDump());
  } else if (strcmp(cmd, "srv dump") == 0) {
    consoleReply(srvDump());
  } else if (strncmp(cmd, "srv set ", 8) == 0) {
    consoleReply(testSetServerProfile(cmd + 8));
  } else if (strcmp(cmd, "token forget") == 0) {
    testForgetToken();
    consoleReply("ok");  // never the token
  } else if (strcmp(cmd, "mp3 abort_at_begin") == 0) {
    testArmMp3AbortAtBegin();
    consoleReply("ok");
  } else if (strncmp(cmd, "token ", 6) == 0) {
    consoleReply(tokenCommand(cmd + 6));
  } else if (strncmp(cmd, "hello ", 6) == 0) {
    consoleReply(testSetHelloFormat(cmd + 6) ? "ok" : "err format");
  } else if (strncmp(cmd, "echo ", 5) == 0) {
    // #709 c3: a reply line of exactly n bytes, "T> " and CRLF included:
    // "echo=<n> " then 'x' filler (console-packet-edge).
    char* end = nullptr;
    const long n = strtol(cmd + 5, &end, 10);
    if (end == cmd + 5 || *end != '\0' || !validEchoLength(n)) {
      consoleReply("err echo_len");
    } else {
      String reply = String("echo=") + n + " ";
      while (reply.length() < echoReplyBytes(static_cast<size_t>(n))) reply += 'x';
      consoleReply(reply);
    }
  } else if (strcmp(cmd, "zlp on") == 0 || strcmp(cmd, "zlp off") == 0) {
    // The packet-edge guard (journal.cpp emit, usb_packet.h), for an A/B run.
    journalSetPacketEdgeGuard(strcmp(cmd, "zlp on") == 0);
    consoleReply(String("ok zlp=") + (journalPacketEdgeGuard() ? "on" : "off") +
                 " late=" + journalPacketEdgeLate());
  } else if (strcmp(cmd, "zlp") == 0) {
    consoleReply(String("zlp=") + (journalPacketEdgeGuard() ? "on" : "off") +
                 " late=" + journalPacketEdgeLate());
  } else {
    consoleReply("err unknown");
  }
}

}  // namespace

void testConsolePoll() {
  // Bounded per call so a flood of bytes never stalls the loop.
  for (int budget = 128; budget > 0 && Serial.available() > 0; --budget) {
    const int c = Serial.read();
    if (c < 0) return;
    if (c == '\r') continue;
    if (c != '\n') {
      if (g_length < kMaxLineChars) {
        g_line[g_length++] = static_cast<char>(c);
      } else {
        g_overflow = true;
      }
      continue;
    }
    const bool overflow = g_overflow;
    g_line[g_length] = '\0';
    g_length = 0;
    g_overflow = false;
    if (overflow) {
      consoleReply("err too_long");
    } else {
      runCommand(g_line);
    }
    return;  // at most one command per loop iteration.
  }
}

}  // namespace bob

#endif  // BOB_TEST_CONSOLE
