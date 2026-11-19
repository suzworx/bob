// Bob Cardputer v2 — shared type helpers.
#include "types.h"

namespace bob {

const char* stateName(State value) {
  switch (value) {
    case State::kBoot: return "BOOT";
    case State::kWifi: return "WIFI";
    case State::kSocket: return "SOCKET";
    case State::kReady: return "READY";
    case State::kCapturing: return "LISTEN";
    case State::kAwaiting: return "WAIT";
    case State::kSelecting: return "SELECT";
    case State::kNewConversation: return "NEWCHAT";
    case State::kPairing: return "PAIR";
    case State::kError: return "ERROR";
    case State::kHelp: return "HELP";
    case State::kAnnounce: return "ANNOUNCE";
    case State::kSettings: return "SETTINGS";
    case State::kUpdating: return "UPDATE";
  }
  return "UNKNOWN";
}

}  // namespace bob
