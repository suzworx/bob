// Saved Wi-Fi networks (include/net_store.h, #675): validation, the cap of
// five, stable slot ids, priority order, and the NVS round trip.
#include <memory>
#include <string>

#include "doctest.h"
#include "fake_kv.h"
#include "net_store.h"
#include "settings_rules.h"

using namespace bob;

namespace {

std::unique_ptr<NetworkList> emptyList() {
  auto list = std::make_unique<NetworkList>();
  netClear(*list);
  return list;
}

std::string orderOf(const NetworkList& list) {
  std::string out;
  for (uint8_t r = 0; r < list.count; ++r) out += static_cast<char>('0' + list.order[r]);
  return out;
}

}  // namespace

TEST_CASE("SSID: 1..32 bytes") {
  CHECK_FALSE(ssidValid(""));
  CHECK(ssidValid("a"));
  CHECK(ssidValid(std::string(32, 'x').c_str()));
  CHECK_FALSE(ssidValid(std::string(33, 'x').c_str()));
  CHECK_FALSE(ssidValid(nullptr));
}

TEST_CASE("password: open, 8..63 printable, or 64 hex") {
  CHECK(passValid(""));
  CHECK_FALSE(passValid("1234567"));
  CHECK(passValid("12345678"));
  CHECK(passValid(std::string(63, '~').c_str()));
  CHECK(passValid(std::string(64, 'a').c_str()));
  CHECK_FALSE(passValid(std::string(64, 'g').c_str()));
  CHECK_FALSE(passValid(std::string(65, 'a').c_str()));
  CHECK_FALSE(passValid("tab\there1"));
  CHECK(passValid("`;.,/ ok!"));  // the keys that navigate elsewhere are password characters
}

TEST_CASE("host and port rules") {
  CHECK(hostValid("api.heybob.xyz"));
  CHECK(hostValid("devbox"));
  CHECK(hostValid("10.0.0.2"));
  CHECK(hostValid("my-host.local"));
  CHECK_FALSE(hostValid(""));
  CHECK_FALSE(hostValid("ws://devbox"));
  CHECK_FALSE(hostValid("devbox:7444"));
  CHECK_FALSE(hostValid("dev box"));
  CHECK_FALSE(hostValid("-devbox"));
  CHECK_FALSE(hostValid("devbox-"));
  CHECK_FALSE(hostValid("a..b"));
  CHECK_FALSE(hostValid("devbox."));
  CHECK_FALSE(hostValid(std::string(64, 'a').c_str()));
  CHECK_FALSE(portValid(0));
  CHECK(portValid(1));
  CHECK(portValid(65535));
  CHECK_FALSE(portValid(65536));
}

TEST_CASE("add appends at the lowest priority and returns a stable slot") {
  auto list = emptyList();
  uint8_t a = kNoSlot, b = kNoSlot;
  CHECK(netAdd(*list, "Home", "password1", 0, &a) == NetError::kOk);
  CHECK(netAdd(*list, "Hotspot", "password2", 0, &b) == NetError::kOk);
  CHECK(a == 0);
  CHECK(b == 1);
  CHECK(list->count == 2);
  CHECK(orderOf(*list) == "01");
}

TEST_CASE("adding a saved SSID updates it in place") {
  auto list = emptyList();
  uint8_t first = kNoSlot, again = kNoSlot;
  netAdd(*list, "Home", "password1", 0, &first);
  netAdd(*list, "Other", "password2", 0, nullptr);
  CHECK(netAdd(*list, "Home", "newpassword", 0, &again) == NetError::kOk);
  CHECK(again == first);
  CHECK(list->count == 2);
  CHECK(std::string(list->slot[first].pass) == "newpassword");
}

TEST_CASE("a sixth network is refused, not silently dropped") {
  auto list = emptyList();
  for (int i = 0; i < 5; ++i) {
    CHECK(netAdd(*list, ("Net" + std::to_string(i)).c_str(), "password1", 0, nullptr) == NetError::kOk);
  }
  CHECK(netAdd(*list, "Net5", "password1", 0, nullptr) == NetError::kFull);
  CHECK(list->count == 5);
}

TEST_CASE("invalid credentials are never stored") {
  auto list = emptyList();
  CHECK(netAdd(*list, "", "password1", 0, nullptr) == NetError::kInvalidSsid);
  CHECK(netAdd(*list, "Home", "short", 0, nullptr) == NetError::kInvalidPass);
  CHECK(list->count == 0);
}

TEST_CASE("an empty password marks the network open") {
  auto list = emptyList();
  uint8_t slot = kNoSlot;
  netAdd(*list, "Cafe", "", 0, &slot);
  CHECK((list->slot[slot].flags & kNetFlagOpen) != 0);
  netUpdate(*list, slot, nullptr, "password1");
  CHECK((list->slot[slot].flags & kNetFlagOpen) == 0);
}

TEST_CASE("remove closes the gap and frees the slot for reuse") {
  auto list = emptyList();
  netAdd(*list, "A", "password1", 0, nullptr);
  netAdd(*list, "B", "password1", 0, nullptr);
  netAdd(*list, "C", "password1", 0, nullptr);
  CHECK(netRemove(*list, 1) == NetError::kOk);
  CHECK(orderOf(*list) == "02");
  CHECK(netRemove(*list, 1) == NetError::kNotFound);
  uint8_t reused = kNoSlot;
  netAdd(*list, "D", "password1", 0, &reused);
  CHECK(reused == 1);
  CHECK(orderOf(*list) == "021");
}

TEST_CASE("move reorders and clamps at both ends") {
  auto list = emptyList();
  for (const char* name : {"A", "B", "C", "D"}) netAdd(*list, name, "password1", 0, nullptr);
  CHECK(netMove(*list, 3, -1) == NetError::kOk);
  CHECK(orderOf(*list) == "0132");
  CHECK(netMove(*list, 3, -10) == NetError::kOk);
  CHECK(orderOf(*list) == "3012");
  CHECK(netMove(*list, 3, 10) == NetError::kOk);
  CHECK(orderOf(*list) == "0123");
  CHECK(netMove(*list, 4, 1) == NetError::kNotFound);
}

TEST_CASE("replace keeps the victim's slot and priority") {
  auto list = emptyList();
  for (const char* name : {"A", "B", "C"}) netAdd(*list, name, "password1", 0, nullptr);
  CHECK(netReplace(*list, 1, "Z", "password9", 0) == NetError::kOk);
  CHECK(orderOf(*list) == "012");
  CHECK(std::string(list->slot[1].ssid) == "Z");
  CHECK(netFind(*list, "B") == kNoSlot);
}

TEST_CASE("renaming onto another saved SSID merges them") {
  auto list = emptyList();
  netAdd(*list, "A", "password1", 0, nullptr);
  netAdd(*list, "B", "password2", 0, nullptr);
  CHECK(netUpdate(*list, 0, "B", nullptr) == NetError::kOk);
  CHECK(list->count == 1);
  CHECK(netFind(*list, "B") == 0);
}

TEST_CASE("save and load round-trip slots, order, flags and results") {
  hosttest::FakeKv kv;
  auto list = emptyList();
  netAdd(*list, "A", "password1", kNetFlagHidden, nullptr);
  netAdd(*list, "B", "", 0, nullptr);
  netAdd(*list, "C", "password3", 0, nullptr);
  netRemove(*list, 0);
  netMove(*list, 2, -1);
  list->slot[1].last = JoinResult::kAuth;
  REQUIRE(netSave(kv, *list));

  auto loaded = emptyList();
  netLoad(kv, *loaded);
  CHECK(orderOf(*loaded) == "21");
  CHECK(std::string(loaded->slot[2].pass) == "password3");
  CHECK(std::string(loaded->slot[1].pass).empty());
  CHECK(loaded->slot[1].last == JoinResult::kAuth);
  CHECK((loaded->slot[1].flags & kNetFlagOpen) != 0);
  CHECK_FALSE(loaded->slot[0].used);
  CHECK_FALSE(kv.has(kNetNamespace, "s0_ssid"));  // a forgotten network leaves nothing behind
  CHECK_FALSE(kv.has(kNetNamespace, "s0_pass"));
}

TEST_CASE("a corrupt stored entry is dropped, never joined") {
  hosttest::FakeKv kv;
  const uint8_t order[kMaxNetworks] = {0, 1, 1, kNoSlot, 7};
  kv.putBytes(kNetNamespace, "order", order, sizeof(order));
  kv.putString(kNetNamespace, "s0_ssid", "Good");
  kv.putString(kNetNamespace, "s0_pass", "password1");
  kv.putString(kNetNamespace, "s1_ssid", "Bad");
  kv.putString(kNetNamespace, "s1_pass", "short");
  auto list = emptyList();
  netLoad(kv, *list);
  CHECK(orderOf(*list) == "0");
}

TEST_CASE("erase all keeps the schema so the seed is not re-applied") {
  hosttest::FakeKv kv;
  auto list = emptyList();
  netAdd(*list, "A", "password1", 0, nullptr);
  netSave(kv, *list);
  REQUIRE(netEraseAll(kv));
  CHECK(kv.keys(kNetNamespace) == std::vector<std::string>{"schema"});
}

// --- #677 Settings: 5-slot fill and replace, reorder/forget at five.

namespace {

// What `T net dump` shows after a reboot: the SSIDs in the order they are tried.
std::string triedAfterReboot(hosttest::FakeKv& kv) {
  auto list = emptyList();
  netLoad(kv, *list);
  std::string out;
  for (uint8_t r = 0; r < list->count; ++r) out += std::string(r ? "," : "") + list->slot[list->order[r]].ssid;
  return out;
}

}  // namespace

TEST_CASE("the Wi-Fi list keeps + Add at five, so a sixth network can be started") {
  auto list = emptyList();
  CHECK(netListRows(*list) == 1);
  for (const char* name : {"A", "B", "C", "D", "E"}) netAdd(*list, name, "password1", 0, nullptr);
  CHECK(netListRows(*list) == 6);
}

TEST_CASE("fill five, then a sixth asks which to replace and takes the victim's slot, first in line") {
  hosttest::FakeKv kv;
  auto list = emptyList();
  for (const char* name : {"A", "B", "C", "D", "E"}) {
    REQUIRE(netCommitJoined(*list, name, "password1", 0, kNoSlot, nullptr, nullptr) == NetError::kOk);
  }
  CHECK(orderOf(*list) == "43210");  // each network joined goes first
  REQUIRE(netSave(kv, *list));

  // Sixth: nothing changes until the customer picks a victim.
  uint8_t slot = kNoSlot, oldRank = kNoSlot;
  CHECK(netCommitJoined(*list, "F", "password6", 0, kNoSlot, &slot, &oldRank) == NetError::kFull);
  CHECK(slot == kNoSlot);
  CHECK(orderOf(*list) == "43210");

  // Replace C (slot 2, rank 2).
  REQUIRE(netCommitJoined(*list, "F", "password6", 0, 2, &slot, &oldRank) == NetError::kOk);
  CHECK(slot == 2);
  CHECK(oldRank == 2);  // [k] keep old order puts it back here
  CHECK(list->count == 5);
  CHECK(orderOf(*list) == "24310");
  CHECK(list->slot[2].last == JoinResult::kOk);
  REQUIRE(netSave(kv, *list));
  CHECK(triedAfterReboot(kv) == "F,E,D,B,A");  // C is never tried again
  CHECK(kv.getString(kNetNamespace, "s2_pass") == "password6");
}

TEST_CASE("a sixth network that is already saved updates in place instead of asking") {
  auto list = emptyList();
  for (const char* name : {"A", "B", "C", "D", "E"}) netAdd(*list, name, "password1", 0, nullptr);
  uint8_t slot = kNoSlot, oldRank = kNoSlot;
  CHECK(netCommitJoined(*list, "D", "newpassword", 0, kNoSlot, &slot, &oldRank) == NetError::kOk);
  CHECK(slot == 3);
  CHECK(oldRank == 3);
  CHECK(orderOf(*list) == "30124");
  CHECK(std::string(list->slot[3].pass) == "newpassword");
}

TEST_CASE("reorder one step at a time and forget at five, surviving each reboot") {
  hosttest::FakeKv kv;
  auto list = emptyList();
  for (const char* name : {"A", "B", "C", "D", "E"}) netAdd(*list, name, "password1", 0, nullptr);
  // Move up takes E from last to first, as Settings does: one step per press.
  for (const char* want : {"A,B,C,E,D", "A,B,E,C,D", "A,E,B,C,D", "E,A,B,C,D"}) {
    REQUIRE(netMove(*list, 4, -1) == NetError::kOk);
    REQUIRE(netSave(kv, *list));
    CHECK(triedAfterReboot(kv) == std::string(want));
  }
  // Move down on the last one, and up on the first, change nothing.
  netMove(*list, 3, 1);
  netMove(*list, 4, -1);
  CHECK(orderOf(*list) == "40123");
  // Forget the first, a middle and the last one.
  netRemove(*list, 4);
  netRemove(*list, 1);
  netRemove(*list, 3);
  REQUIRE(netSave(kv, *list));
  CHECK(triedAfterReboot(kv) == "A,C");
  for (const char* key : {"s1_ssid", "s3_pass", "s4_ssid", "s4_pass"}) CHECK_FALSE(kv.has(kNetNamespace, key));
  // Freed slots are reused, and the list fills to five again.
  for (const char* name : {"X", "Y", "Z"}) {
    REQUIRE(netCommitJoined(*list, name, "password1", 0, kNoSlot, nullptr, nullptr) == NetError::kOk);
  }
  CHECK(list->count == 5);
  REQUIRE(netSave(kv, *list));
  CHECK(triedAfterReboot(kv) == "Z,Y,X,A,C");
}

TEST_CASE("Settings closes after 2 minutes idle; Setup never does") {
  CHECK_FALSE(settingsIdleClose(1000 + 119999, 1000, false));
  CHECK(settingsIdleClose(1000 + 120000, 1000, false));
  CHECK_FALSE(settingsIdleClose(1000 + 600000, 1000, true));
  CHECK(settingsIdleClose(119000, 0xFFFFFFFFu - 1000, false));  // across the millis() rollover
  CHECK_FALSE(settingsIdleClose(1000, 1005, false));  // a later stamp is not 49 days old
}

TEST_CASE("a ringing timer closes Settings; nothing else does, and never Setup or a join") {
  CHECK(settingsYieldsToAnnouncement(true, false, false));
  CHECK_FALSE(settingsYieldsToAnnouncement(false, false, false));  // a chime waits for Settings to close
  CHECK_FALSE(settingsYieldsToAnnouncement(true, true, false));    // guided Setup is never interrupted
  CHECK_FALSE(settingsYieldsToAnnouncement(true, false, true));    // a scan or join test finishes first
}
