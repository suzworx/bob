#include <cstring>
#include "doctest.h"
#include "device_log.h"
#include "support.h"

TEST_CASE("device diagnostics contain only fixed events and bounded numeric fields") {
  char buffer[320];
  const size_t length = bob::encodeDeviceLog(buffer, sizeof(buffer), "playback_started", "turn_123456_v2", 123456, 100000, 80000);
  CHECK(length > 0);
  CHECK(std::string(buffer) == hosttest::str(hosttest::fixture("device_log")));
  CHECK(bob::encodeDeviceLog(buffer, sizeof(buffer), "private transcript", nullptr, 1, 2, 3) == 0);
  CHECK(bob::encodeDeviceLog(buffer, sizeof(buffer), "server_error", "https://private", 1, 2, 3) == 0);
  CHECK(bob::encodeDeviceLog(buffer, 10, "server_error", nullptr, 1, 2, 3) == 0);
  CHECK(bob::encodeDeviceLog(buffer, sizeof(buffer), "welcome_accepted", nullptr, 0xffffffff, 0xffffffff, 0xffffffff) > 0);
  CHECK(std::strstr(buffer, "turn_ref") == nullptr);
}

TEST_CASE("device diagnostic rate limit is bounded and survives uptime wrap") {
  bob::DeviceLogRate rate;
  CHECK(rate.due(0));
  rate.sent(0);
  CHECK_FALSE(rate.due(999));
  CHECK(rate.due(1000));
  rate.sent(0xffffff00);
  CHECK_FALSE(rate.due(100));
  CHECK(rate.due(1000));
  CHECK(sizeof(rate) <= 8);
}
