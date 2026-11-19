#include "doctest.h"
#include "ota_manual.h"
using namespace bob;
namespace { OtaOffer candidate() { OtaOffer o; strcpy(o.version, "2.0.0"); o.size = 1000; return o; } }
TEST_CASE("manual check receives candidate without install authorization") {
  ManualOta m; const auto o = candidate(); m.begin(10);
  CHECK(m.receive(&o, "1.0.0")); CHECK(m.phase == ManualOtaPhase::kOffered);
  CHECK_FALSE(m.confirm("3.0.0")); CHECK(m.confirm("2.0.0"));
}
TEST_CASE("manual cancel timeout and disconnect cannot authorize a late offer") {
  const auto o = candidate(); ManualOta m; m.begin(10);
  SUBCASE("cancel") { m.cancel(); }
  SUBCASE("timeout") { m.tick(15010); CHECK(m.phase == ManualOtaPhase::kFailed); }
  CHECK(m.receive(&o, "1.0.0")); CHECK_FALSE(m.confirm("2.0.0"));
  m.disconnected(); CHECK_FALSE(m.awaitingReply); CHECK_FALSE(m.confirm("2.0.0"));
}
TEST_CASE("no offer and old invalid offers stay non-installable") {
  ManualOta m; auto o = candidate();
  SUBCASE("null") { m.begin(1); CHECK(m.receive(nullptr, "1.0.0")); }
  SUBCASE("old") { m.begin(1); CHECK(m.receive(&o, "2.0.0")); }
  SUBCASE("size") { m.begin(1); o.size = 0; CHECK(m.receive(&o, "1.0.0")); }
  CHECK(m.phase == ManualOtaPhase::kNoOffer); CHECK_FALSE(m.confirm("2.0.0"));
}
TEST_CASE("candidate is pinned until cancellation even if another offer arrives") {
  ManualOta m; auto o = candidate(); m.begin(1); m.receive(&o, "1.0.0");
  strcpy(o.version, "3.0.0"); CHECK(m.receive(&o, "1.0.0"));
  CHECK(strcmp(m.offer.version, "2.0.0") == 0);
}
TEST_CASE("manual timeout tolerates millis wrap") {
  ManualOta m; m.begin(0xfffffff0u); m.tick(14983); CHECK(m.phase == ManualOtaPhase::kChecking);
  m.tick(14984); CHECK(m.phase == ManualOtaPhase::kFailed);
}

TEST_CASE("reviewed candidate expires rather than retaining consent indefinitely") {
  ManualOta m; const auto o = candidate(); m.begin(1); m.receive(&o, "1.0.0");
  m.tick(120001); CHECK_FALSE(m.confirm("2.0.0"));
}

TEST_CASE("loop timestamp before manual key event does not timeout the new check") {
  ManualOta m; m.begin(1001); m.tick(1000);
  CHECK(m.phase == ManualOtaPhase::kChecking);
  m.tick(16000); CHECK(m.phase == ManualOtaPhase::kChecking);
  m.tick(16001); CHECK(m.phase == ManualOtaPhase::kFailed);
}

TEST_CASE("numeric offer label does not change full consent identifier") {
  char shown[24]; otaNumericVersionText("2.3.4-dev+abcdef", shown, sizeof(shown));
  CHECK(strcmp(shown, "2.3.4") == 0);
  ManualOta m; auto o = candidate(); strcpy(o.version, "2.3.4-dev+abcdef");
  m.begin(1); m.receive(&o, "1.0.0");
  CHECK_FALSE(m.confirm("2.3.4")); CHECK(m.confirm("2.3.4-dev+abcdef"));
}
