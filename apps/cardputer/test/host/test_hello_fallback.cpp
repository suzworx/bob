// The hello fallback (include/protocol.h): a server older than #345 answers a
// hello carrying fw_version/caps with BAD_MESSAGE and no welcome. The device
// then resends a bare hello {format_id} once on that connection.
#include <cstring>

#include "doctest.h"
#include "protocol.h"

using bob::AudioFormat;

TEST_CASE("BAD_MESSAGE before welcome after an extended hello sends the bare hello") {
  CHECK(bob::helloFallbackNeeded(false, true, false, "BAD_MESSAGE"));
}

TEST_CASE("the fallback is sent at most once per connection") {
  CHECK_FALSE(bob::helloFallbackNeeded(false, true, true, "BAD_MESSAGE"));
}

TEST_CASE("a welcomed session never falls back: the error belongs to a later message") {
  CHECK_FALSE(bob::helloFallbackNeeded(true, true, false, "BAD_MESSAGE"));
  CHECK_FALSE(bob::helloFallbackNeeded(true, true, true, "BAD_MESSAGE"));
}

TEST_CASE("a bare hello that failed has nothing to fall back to") {
  CHECK_FALSE(bob::helloFallbackNeeded(false, false, false, "BAD_MESSAGE"));
}

TEST_CASE("pairing and other errors before welcome are not hello failures") {
  CHECK_FALSE(bob::helloFallbackNeeded(false, true, false, "UNPAIRED"));
  CHECK_FALSE(bob::helloFallbackNeeded(false, true, false, "PAIRING_RATE_LIMITED"));
  CHECK_FALSE(bob::helloFallbackNeeded(false, true, false, "INTERNAL"));
  CHECK_FALSE(bob::helloFallbackNeeded(false, true, false, nullptr));
}

TEST_CASE("the fallback hello is the pre-#345 hello: format_id only") {
  const String bare = bob::buildHello(AudioFormat::kMp3);
  CHECK(bare.indexOf("\"type\":\"hello\"") >= 0);
  CHECK(bare.indexOf("\"payload\":{\"format_id\":2}}") >= 0);
  CHECK(bare.indexOf("fw_version") < 0);
  CHECK(bare.indexOf("caps") < 0);
}
