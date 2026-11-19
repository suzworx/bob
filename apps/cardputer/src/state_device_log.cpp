#include "state_internal.h"
#include "device_log.h"

namespace bob {
namespace fsm {

static bool enabled = false;

void configureDeviceLog(const String& welcome) {
  // Old servers never receive a message type they do not understand.
  enabled = welcome.indexOf("\"device_log\":true") >= 0;
}

void sendDeviceLog(const char* event) {
  // Main-loop only. One small stack buffer and 8 static bytes; existing
  // control queue used only when empty, no logging queue or payload capture.
  static DeviceLogRate rate;
  const uint32_t now = millis();
  if (!welcomed || !enabled || !deviceLogEventAllowed(event) || !rate.due(now)) return;
  rate.sent(now);
  char body[320];
  const char* ref = std::strcmp(event, "welcome_accepted") == 0 || turnRef.isEmpty() ? nullptr : turnRef.c_str();
  const size_t length = encodeDeviceLog(body, sizeof(body), event, ref, now,
      heap_caps_get_free_size(MALLOC_CAP_8BIT), heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
  if (length > 0) network.sendDiagnostic(body, length);
}

}  // namespace fsm
}  // namespace bob
