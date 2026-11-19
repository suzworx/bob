#pragma once
#include <cstdint>
namespace bob {
enum class AssistantLabel : uint8_t { kName, kTitle, kReady, kAway, kGreeting };
// The assistant's name on screen; the same whichever wake word is listening.
inline const char* assistantDisplay(AssistantLabel label) {
  switch (label) {
    case AssistantLabel::kName: return "Bob";
    case AssistantLabel::kTitle: return "BOB v2";
    case AssistantLabel::kReady: return "BOB v2 READY";
    case AssistantLabel::kAway: return "BOB IS AWAY";
    case AssistantLabel::kGreeting: return "HI, I'M BOB";
  }
  return "Bob";
}
}
