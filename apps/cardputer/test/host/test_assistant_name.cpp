#include <string>
#include "doctest.h"
#include "protocol.h"

TEST_CASE("assistant name is sent only after negotiation and is Bob whichever wake word listens") {
  const String oldServer = bob::buildTurnStart("turn_identity", nullptr, bob::WakeWord::kBob, false);
  CHECK(std::string(oldServer.c_str()).find("assistant_name") == std::string::npos);
  const String heyBob = bob::buildTurnStart("turn_identity", nullptr, bob::WakeWord::kBob, true);
  CHECK(std::string(heyBob.c_str()).find("\"assistant_name\":\"bob\"") != std::string::npos);
  const String alexa = bob::buildTurnStart("turn_identity", nullptr, bob::WakeWord::kAlexa, true);
  CHECK(std::string(alexa.c_str()).find("\"assistant_name\":\"bob\"") != std::string::npos);
}

TEST_CASE("assistant name negotiation never sticks across an older welcome") {
  CHECK(bob::welcomeSupportsAssistantName("{\"payload\":{\"assistant_name\":true}}"));
  CHECK_FALSE(bob::welcomeSupportsAssistantName("{\"payload\":{\"assistant_name\":false}}"));
  CHECK_FALSE(bob::welcomeSupportsAssistantName("{\"payload\":{}}"));
}
