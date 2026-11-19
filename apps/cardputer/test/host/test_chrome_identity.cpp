#include <cstring>
#include "doctest.h"
#include "chrome_identity.h"
#include "types.h"
using namespace bob;
TEST_CASE("assistant labels always say Bob") {
  CHECK(strcmp(assistantDisplay(AssistantLabel::kReady), "BOB v2 READY") == 0);
  CHECK(strcmp(assistantDisplay(AssistantLabel::kAway), "BOB IS AWAY") == 0);
  CHECK(strcmp(assistantDisplay(AssistantLabel::kGreeting), "HI, I'M BOB") == 0);
  CHECK(strcmp(assistantDisplay(AssistantLabel::kTitle), "BOB v2") == 0);
  CHECK(strcmp(assistantDisplay(AssistantLabel::kName), "Bob") == 0);
}

TEST_CASE("screen firmware version is numeric metadata without a commit hash") {
  int dots = 0;
  for (const char* p = kFirmwareNumericVersion; *p; ++p) {
    CHECK(((*p >= '0' && *p <= '9') || *p == '.'));
    if (*p == '.') ++dots;
  }
  CHECK(dots == 2);
}
