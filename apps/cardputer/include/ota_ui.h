// Narrow Settings interface to the update state machine; no transport internals.
#pragma once
#include "ota_manual.h"
namespace bob { namespace fsm {
struct UpdateView {
  ManualOtaPhase phase;
  const char* version;
  const char* message;
  bool connected;
  bool privateBuild;
};
UpdateView updateView();
bool updateBusy();
void updateCheckNow();
bool updateConfirmNow(const char* version);
void updateCancelManual();
void updateSettingsClosed();
} }
