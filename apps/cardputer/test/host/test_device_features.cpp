// Epic #311 messages (src/protocol.cpp), driven by the exact bytes in
// test/fixtures/wire. apps/api/tests/wire-fixtures.test.ts proves the same
// fixtures are what the server's real builders send (reply_text, announce,
// device_control) and what its schema accepts (device_state, announce_ack,
// cancel). A reply_text parser that looked for the envelope's turn_ref inside
// the payload passed every compile and failed every turn on the device
// (HIL run 20260923-225553-d22d); these cases pin the envelope/payload split.
#include <cstring>
#include <string>

#include "doctest.h"
#include "protocol.h"
#include "support.h"

using hosttest::fixture;
using hosttest::str;

namespace {
constexpr unsigned long kFixtureMillis = 123456;  // ids in the fixtures: <prefix>_123456_v2.
}

TEST_CASE("reply_text: turn_ref from the envelope, heard and reply from the payload") {
  bob::ReplyText out;
  REQUIRE(bob::parseReplyText(fixture("reply_text"), out));
  CHECK(std::string(out.turnRef) == "turn_0001_abcd");
  CHECK(std::string(out.heard) == "What is on \"today\"?");
  CHECK(std::string(out.reply) == "Two things - the dentist at 3 and book club at 7.");  // em dash folded.
}

TEST_CASE("reply_text: empty heard and reply are legal") {
  bob::ReplyText out;
  REQUIRE(bob::parseReplyText(fixture("reply_text_empty"), out));
  CHECK(std::string(out.turnRef) == "turn_0001_abcd");
  CHECK(out.heard[0] == '\0');
  CHECK(out.reply[0] == '\0');
}

TEST_CASE("reply_text: rejects a turn_ref that is missing or only inside the payload") {
  bob::ReplyText out;
  CHECK_FALSE(bob::parseReplyText(
      "{\"v\":1,\"type\":\"reply_text\",\"id\":\"rtxt_1\",\"payload\":{\"heard\":\"a\",\"reply\":\"b\"}}", out));
  CHECK_FALSE(bob::parseReplyText(
      "{\"v\":1,\"type\":\"reply_text\",\"id\":\"rtxt_1\",\"payload\":{\"turn_ref\":\"turn_1\",\"heard\":\"a\",\"reply\":\"b\"}}",
      out));
  CHECK_FALSE(bob::parseReplyText(
      "{\"v\":1,\"type\":\"reply_text\",\"id\":\"rtxt_1\",\"turn_ref\":\"turn_1\"}", out));
}

TEST_CASE("reply_text: key-like text inside heard cannot move the turn_ref") {
  bob::ReplyText out;
  REQUIRE(bob::parseReplyText(
      "{\"v\":1,\"type\":\"reply_text\",\"id\":\"rtxt_1\",\"turn_ref\":\"turn_real\","
      "\"payload\":{\"heard\":\"say \\\"turn_ref\\\":\\\"turn_fake\\\"\",\"reply\":\"ok\"}}",
      out));
  CHECK(std::string(out.turnRef) == "turn_real");
  CHECK(std::string(out.reply) == "ok");
}

TEST_CASE("reply_text: only the reply for the turn in flight is kept") {
  using bob::ReplyTextFate;
  using bob::replyTextFate;
  // The turn in flight.
  CHECK(replyTextFate(true, "turn_2", "turn_2", "") == ReplyTextFate::kKeep);
  CHECK(replyTextFate(true, "turn_2", "turn_2", "turn_1") == ReplyTextFate::kKeep);
  // A late reply for the stopped turn, whether or not a new turn is on.
  CHECK(replyTextFate(false, "turn_1", "turn_1", "turn_1") == ReplyTextFate::kCancelledTurn);
  CHECK(replyTextFate(true, "turn_1", "turn_2", "turn_1") == ReplyTextFate::kCancelledTurn);
  // An earlier turn's reply while a new turn waits: it must not become its card.
  CHECK(replyTextFate(true, "turn_1", "turn_2", "") == ReplyTextFate::kOtherTurn);
  CHECK(replyTextFate(true, "turn_1", "", "") == ReplyTextFate::kOtherTurn);
  // Outside a turn (READY with a card up, HELP, ...).
  CHECK(replyTextFate(false, "turn_2", "turn_2", "") == ReplyTextFate::kNotInTurn);
  // An empty cancelled ref never matches.
  CHECK(replyTextFate(true, "turn_2", "turn_2", nullptr) == ReplyTextFate::kKeep);
  CHECK(std::string(bob::replyTextFateName(ReplyTextFate::kCancelledTurn)) == "cancelled_turn");
  CHECK(std::string(bob::replyTextFateName(ReplyTextFate::kKeep)) == "kept");
}

TEST_CASE("reply_text: extractTurnRef reads the same envelope field") {
  char ref[bob::kTurnRefBytes];
  REQUIRE(bob::extractTurnRef(fixture("reply_text"), ref, sizeof(ref)));
  CHECK(std::string(ref) == "turn_0001_abcd");
}

TEST_CASE("announce: a timer ring") {
  bob::Announcement out;
  REQUIRE(bob::parseAnnounce(fixture("announce_ring"), out));
  CHECK(std::string(out.id) == "tm_0123456789abcdef");
  CHECK(out.kind == bob::AnnounceKind::kTimer);
  CHECK(out.ring);
  CHECK(std::string(out.title) == "Pasta");
  CHECK(out.body[0] == '\0');
}

TEST_CASE("announce: a reminder chime with a body") {
  bob::Announcement out;
  REQUIRE(bob::parseAnnounce(fixture("announce_notice"), out));
  CHECK(std::string(out.id) == "rm_0123456789abcdef_1790000000000");
  CHECK(out.kind == bob::AnnounceKind::kReminder);
  CHECK_FALSE(out.ring);
  CHECK(std::string(out.title) == "Take the bins out");
  CHECK(std::string(out.body) == "Collection is \"early\" tomorrow");
}

TEST_CASE("device_control: a single field sets only that field") {
  bob::DeviceControl out;
  REQUIRE(bob::parseDeviceControl(fixture("device_control_volume"), out));
  CHECK(out.hasVolume);
  CHECK(out.volume == 3);
  CHECK_FALSE(out.hasMuted);
  CHECK_FALSE(out.hasMode);
  CHECK_FALSE(out.hasDnd);
}

TEST_CASE("device_control: mode and dnd without volume or muted") {
  bob::DeviceControl out;
  REQUIRE(bob::parseDeviceControl(fixture("device_control_mode_dnd"), out));
  CHECK_FALSE(out.hasVolume);
  CHECK_FALSE(out.hasMuted);
  CHECK(out.hasMode);
  CHECK(out.mode == bob::DeviceMode::kWake);
  CHECK(out.hasDnd);
  CHECK_FALSE(out.dnd);
}

TEST_CASE("device_control: every field at once, ring settings after dnd (#389)") {
  bob::DeviceControl out;
  REQUIRE(bob::parseDeviceControl(fixture("device_control_all"), out));
  CHECK((out.hasVolume && out.volume == 10));
  CHECK((out.hasMuted && out.muted));
  CHECK((out.hasMode && out.mode == bob::DeviceMode::kAnnounceOnly));
  CHECK((out.hasDnd && out.dnd));
  CHECK((out.hasRingSeconds && out.ringSeconds == 120));
  CHECK((out.hasRingSound && out.ringSound == bob::RingSound::kPulse));
}

TEST_CASE("device_control: wake_word is the last key and parses (bob)") {
  bob::DeviceControl out;
  REQUIRE(bob::parseDeviceControl(fixture("device_control_wake_word"), out));
  CHECK((out.hasWakeWord && out.wakeWord == bob::kWakeWordDefault));  // "bob" selects the build's default model
  CHECK((out.hasRingSound && out.ringSound == bob::RingSound::kPulse));
  // Either model is Bob on the wire; never "alexa".
  CHECK(std::string(bob::wakeWordWireName(bob::WakeWord::kAlexa)) == "bob");
  CHECK(std::string(bob::wakeWordWireName(bob::WakeWord::kBob)) == "bob");
  bob::DeviceControl none;
  CHECK_FALSE(bob::parseDeviceControl(
      "{\"v\":1,\"type\":\"device_control\",\"id\":\"dctl_1\",\"payload\":{\"wake_word\":\"alexa\"}}", none));
  CHECK_FALSE(none.hasWakeWord);
}

TEST_CASE("device_control: ring settings alone are enough (#389)") {
  bob::DeviceControl out;
  REQUIRE(bob::parseDeviceControl(fixture("device_control_ring"), out));
  CHECK_FALSE(out.hasVolume);
  CHECK_FALSE(out.hasMuted);
  CHECK_FALSE(out.hasMode);
  CHECK_FALSE(out.hasDnd);
  CHECK((out.hasRingSeconds && out.ringSeconds == 60));
  CHECK((out.hasRingSound && out.ringSound == bob::RingSound::kChime));
}

// The server's schema never sends these (no fixture can hold them); the
// parser must still ignore them rather than apply a bad value.
TEST_CASE("device_control: out-of-range ring_seconds and unknown ring_sound are ignored") {
  bob::DeviceControl out;
  CHECK_FALSE(bob::parseDeviceControl(
      "{\"v\":1,\"type\":\"device_control\",\"id\":\"dctl_1\",\"payload\":{\"ring_seconds\":9}}", out));
  CHECK_FALSE(bob::parseDeviceControl(
      "{\"v\":1,\"type\":\"device_control\",\"id\":\"dctl_1\",\"payload\":{\"ring_seconds\":121}}", out));
  CHECK_FALSE(bob::parseDeviceControl(
      "{\"v\":1,\"type\":\"device_control\",\"id\":\"dctl_1\",\"payload\":{\"ring_seconds\":1000}}", out));
  CHECK_FALSE(bob::parseDeviceControl(
      "{\"v\":1,\"type\":\"device_control\",\"id\":\"dctl_1\",\"payload\":{\"ring_seconds\":30.5}}", out));
  CHECK_FALSE(bob::parseDeviceControl(
      "{\"v\":1,\"type\":\"device_control\",\"id\":\"dctl_1\",\"payload\":{\"ring_sound\":\"siren\"}}", out));
  REQUIRE(bob::parseDeviceControl(
      "{\"v\":1,\"type\":\"device_control\",\"id\":\"dctl_1\",\"payload\":{\"dnd\":false,\"ring_seconds\":60,\"ring_sound\":\"siren\"}}",
      out));
  CHECK((out.hasRingSeconds && out.ringSeconds == 60));
  CHECK_FALSE(out.hasRingSound);
}

TEST_CASE("buildDeviceState matches the device_state fixtures") {
  hostshim::setMillis(kFixtureMillis);
  bob::DeviceSettings settings;  // ring_seconds 30, ring_sound classic by default.
  settings.volume = 6;
  settings.muted = false;
  settings.mode = bob::DeviceMode::kWake;
  settings.dnd = true;
  CHECK(str(bob::buildDeviceState(settings, 87, 1)) == str(fixture("device_state")));
  settings.volume = 0;
  settings.muted = true;
  settings.mode = bob::DeviceMode::kPtt;
  settings.dnd = false;
  CHECK(str(bob::buildDeviceState(settings, -1, -1)) == str(fixture("device_state_unknown_battery")));
}

TEST_CASE("buildAnnounceAck matches the announce_ack fixtures") {
  hostshim::setMillis(kFixtureMillis);
  CHECK(str(bob::buildAnnounceAck("tm_0123456789abcdef", bob::AnnounceAction::kDismissed)) ==
        str(fixture("announce_ack")));
  // #389: the ring ran its full ring_seconds with no dismiss.
  CHECK(str(bob::buildAnnounceAck("tm_0123456789abcdef", bob::AnnounceAction::kMissed)) ==
        str(fixture("announce_ack_missed")));
}

TEST_CASE("buildCancel matches the cancel fixture") {
  hostshim::setMillis(kFixtureMillis);
  CHECK(str(bob::buildCancel("turn_0001_abcd")) == str(fixture("cancel")));
}
