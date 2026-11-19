// OTA-5B: the pending record settles into the last_ota outcome across a reboot.
#include "doctest.h"
#include "fake_kv.h"
#include "ota_record.h"

using namespace bob;
using hosttest::FakeKv;

TEST_CASE("running the target settles to ok and clears pending") {
  FakeKv kv;
  otaWritePending(kv, "0.3.0", "0.4.0");
  otaSettleBoot(kv, "0.4.0");
  OtaLast last;
  REQUIRE(otaReadLast(kv, &last));
  CHECK(strcmp(last.result, "ok") == 0);
  CHECK(strcmp(last.to, "0.4.0") == 0);
  CHECK(last.reason[0] == '\0');
  CHECK_FALSE(kv.has(kOtaNamespace, kOtaKeyFrom));
  CHECK_FALSE(kv.has(kOtaNamespace, kOtaKeyTo));
}

TEST_CASE("running the old version settles to rolled_back") {
  FakeKv kv;
  otaWritePending(kv, "0.3.0", "0.4.0");
  otaSettleBoot(kv, "0.3.0");
  OtaLast last;
  REQUIRE(otaReadLast(kv, &last));
  CHECK(strcmp(last.result, "rolled_back") == 0);
  CHECK(strcmp(last.to, "0.4.0") == 0);
  CHECK(strcmp(last.reason, "boot_failed") == 0);
}

TEST_CASE("a third version (USB flash) reports nothing new and still clears pending") {
  FakeKv kv;
  otaWritePending(kv, "0.3.0", "0.4.0");
  otaSettleBoot(kv, "0.9.0");
  OtaLast last;
  CHECK_FALSE(otaReadLast(kv, &last));
  CHECK_FALSE(kv.has(kOtaNamespace, kOtaKeyFrom));
}

TEST_CASE("no pending record leaves the last outcome alone") {
  FakeKv kv;
  otaWriteFailed(kv, "0.4.0", "hash");
  otaSettleBoot(kv, "0.3.0");
  OtaLast last;
  REQUIRE(otaReadLast(kv, &last));
  CHECK(strcmp(last.result, "failed") == 0);
  CHECK(strcmp(last.reason, "hash") == 0);
}

TEST_CASE("an unconfirmed target keeps the pending record; a rollback then settles it") {
  FakeKv kv;
  otaWritePending(kv, "0.3.0", "0.4.0");
  otaSettleBoot(kv, "0.4.0", true);
  OtaLast last;
  CHECK_FALSE(otaReadLast(kv, &last));
  CHECK(kv.has(kOtaNamespace, kOtaKeyTo));
  otaSettleBoot(kv, "0.3.0");
  REQUIRE(otaReadLast(kv, &last));
  CHECK(strcmp(last.result, "rolled_back") == 0);
}

TEST_CASE("confirming the target after an unconfirmed boot reports ok") {
  FakeKv kv;
  otaWritePending(kv, "0.3.0", "0.4.0");
  otaSettleBoot(kv, "0.4.0", true);
  otaSettleBoot(kv, "0.4.0");
  OtaLast last;
  REQUIRE(otaReadLast(kv, &last));
  CHECK(strcmp(last.result, "ok") == 0);
  CHECK_FALSE(kv.has(kOtaNamespace, kOtaKeyTo));
}

TEST_CASE("clearing the last outcome after the server has it leaves nothing to report") {
  FakeKv kv;
  otaWritePending(kv, "0.3.0", "0.4.0");
  otaSettleBoot(kv, "0.3.0");
  OtaLast last;
  REQUIRE(otaReadLast(kv, &last));
  otaClearLast(kv);
  CHECK_FALSE(otaReadLast(kv, &last));
  CHECK(last.result[0] == '\0');
}
