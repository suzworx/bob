// Visual-gate shim: copied into bob-sim's shim dir only when the checkout lacks one. The status chips read the
// signal strength; the sim reports a strong, fixed link so renders repeat.
#pragma once

struct WiFiClass
{
  int RSSI() const { return -55; }
};
inline WiFiClass WiFi;
