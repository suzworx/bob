// Bob Cardputer v2 — the device's settings store at runtime (#675): the NVS
// KvStore, the first-boot migration, the active server profile and endpoint,
// and the Wi-Fi network the device joins. Everything persisted goes through
// the pure modules (net_store.h, server_profile.h, device_token.h,
// settings_migration.h); this file only binds them to NVS and the journal.
#pragma once

#include <cstddef>

#include "kv_store.h"
#include "server_profile.h"

// Developer builds (the poc and hil envs) seed from secrets.h and may use the
// Dev and Custom profiles over plain ws://. Other builds are Production-only
// until developer options are unlocked, and never connect in plain text.
#ifndef BOB_DEV_OPTIONS
#define BOB_DEV_OPTIONS 0
#endif

namespace bob {

constexpr bool kDevOptions = BOB_DEV_OPTIONS != 0;

// The device's NVS (src/nvs_kv.cpp).
KvStore& deviceStore();

// Runs the migration, then loads the active profile and endpoint. Call once in
// setup, after settingsLoad() and before Wi-Fi. Journals settings_migrated when
// the migration ran.
void deviceSettingsBegin();

// Re-reads the active profile and endpoint after Settings switched servers
// (#679). The next socket connect uses them and that profile's token.
void deviceSettingsReloadProfile();

Profile activeProfile();
const Endpoint& activeEndpoint();

// True when there is a saved network to join and a server to reach.
bool configured();

// Copies the highest-priority saved network into ssid/pass (NUL-terminated).
// Returns its slot id, or kNoSlot (0xFF) when none is saved. Credentials stay
// in the caller's buffers only as long as it needs them.
uint8_t firstSavedNetwork(char* ssid, size_t ssidSize, char* pass, size_t passSize);

}  // namespace bob
