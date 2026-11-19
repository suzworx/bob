// bob-sim shim: Wi-Fi status (the sim never joins a network).
#pragma once
struct WiFiStub { int RSSI() const { return -55; } };
inline WiFiStub WiFi;
