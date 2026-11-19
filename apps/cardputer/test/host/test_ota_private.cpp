#include "doctest.h"
#define BOB_WAKE_MODEL_BOB 1
#include "ota_build.h"

TEST_CASE("private Hey Bob candidate builds cannot replace their model with public firmware") {
  CHECK_FALSE(bob::kAcceptStandardOta);
}
