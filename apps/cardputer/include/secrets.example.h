#pragma once

// Copy this file to secrets.h and fill in local values. Do not commit secrets.h.
#define WIFI_SSID "your-wifi-name"
#define WIFI_PASSWORD "your-wifi-password"
#define V2_HOST "192.168.1.10"
#define V2_PORT 7444
// Set V2_USE_TLS to 1 for the public wss:// endpoint (https://api.heybob.xyz
// on 443); leave at 0 for the plain ws:// LAN dev server.
#define V2_USE_TLS 0
// DEVICE_SECRET is the legacy shared-secret device credential. New firmware
// pairs with a code instead, so it is optional: leave it out unless the server
// still runs the old shared-secret path, and build with -DBOB_LEGACY_SECRET=1.
// #define DEVICE_SECRET "legacy-device-secret"